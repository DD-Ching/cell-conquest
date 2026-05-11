"""
train_league_fast.py — Resume + AlphaStar-style self-play league.

What it does:
  - Loads /kaggle/working/league/final.pt as starting policy (resume).
  - Loads all /kaggle/working/league/ckpt_*.pt into a league pool.
  - Each iteration randomly assigns opponents to slots 1/2/3:
      50% mirror (latest)  ↗ helps stability
      35% pool sample      ↗ diversity / "猜疑" / counter-strategies
      15% heuristic        ↗ keeps agent grounded against the baseline
  - Sole survivor / leader at timeout = win. Saves new checkpoints into pool.

Run on Kaggle (assuming cell_env.py uploaded as dataset 'envpyy'):
    %run /path/to/train_league_fast.py
"""
from __future__ import annotations
import sys, os, time, random, glob
for _p in glob.glob('/kaggle/input/*'):
    if glob.glob(f'{_p}/cell_env.py'):
        sys.path.insert(0, _p); print(f'cell_env from: {_p}'); break

from contextlib import nullcontext
from collections import deque
from typing import List, Optional, Dict, Tuple
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from cell_env import CellEnv, N_PLAYERS, NEUTRAL

torch.backends.cudnn.benchmark = True
torch.set_float32_matmul_precision('high')
DEVICE = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
print(f"Device: {DEVICE}, AMP: {DEVICE.type == 'cuda'}")

# ---------------- Tunables ----------------
N_NODES_FIXED = 40
N_ENVS        = 256
N_STEPS       = 64
HIDDEN        = 96
GRU_DIM       = 96
USE_AMP       = True
USE_COMPILE   = True
PPO_MB_SIZE   = 2048
PPO_EPOCHS    = 4
LR            = 1.5e-4              # smaller for fine-tune from existing policy
LEAGUE_DIR    = '/kaggle/working/league'
_finals = glob.glob('/kaggle/input/**/final.pt', recursive=True) or glob.glob(f'{LEAGUE_DIR}/final.pt')
RESUME_FROM   = _finals[0] if _finals else None
print(f'RESUME_FROM = {RESUME_FROM}')
SAVE_EVERY    = 20
LEAGUE_MAX    = 30                  # cap pool size (drop oldest)
P_MIRROR      = 0.50                # latest agent (mirror match)
P_POOL        = 0.35                # frozen old self
P_HEURISTIC   = 0.15                # heuristic baseline


# ===================================================
# Policy (must match shape used to save checkpoints)
# ===================================================
class GraphConv(nn.Module):
    def __init__(self, dim):
        super().__init__()
        self.self_lin = nn.Linear(dim, dim)
        self.nbr_lin  = nn.Linear(dim, dim)
    def forward(self, h, adj_norm):
        return F.gelu(self.self_lin(h) + self.nbr_lin(adj_norm @ h))


class GraphPolicy(nn.Module):
    def __init__(self, in_dim, hidden=HIDDEN, gru_dim=GRU_DIM):
        super().__init__()
        self.encode = nn.Linear(in_dim, hidden)
        self.gc1 = GraphConv(hidden)
        self.gc2 = GraphConv(hidden)
        self.gc3 = GraphConv(hidden)
        self.gru = nn.GRUCell(hidden * 2, gru_dim)
        self.gru_dim = gru_dim
        self.actor_q = nn.Linear(hidden + gru_dim, hidden)
        self.actor_k = nn.Linear(hidden, hidden)
        self.no_op_head = nn.Linear(hidden + gru_dim, 1)
        self.critic = nn.Sequential(
            nn.Linear(hidden * 2 + gru_dim, hidden), nn.GELU(),
            nn.Linear(hidden, 1),
        )

    def forward(self, nf, am, hidden):
        h = F.gelu(self.encode(nf))
        deg = am.sum(-1, keepdim=True).clamp(min=1.0)
        adj_norm = am / deg
        h = self.gc1(h, adj_norm); h = self.gc2(h, adj_norm); h = self.gc3(h, adj_norm)
        pmean = h.mean(dim=1); pmax = h.max(dim=1).values
        pooled = torch.cat([pmean, pmax], dim=-1)
        new_hidden = self.gru(pooled, hidden)
        gru_b = new_hidden
        h_q = torch.cat([h, gru_b.unsqueeze(1).expand(-1, h.size(1), -1)], dim=-1)
        edge_logits = self.actor_q(h_q) @ self.actor_k(h).transpose(-2, -1)
        no_op = self.no_op_head(torch.cat([pmean, gru_b], dim=-1)).squeeze(-1)
        value = self.critic(torch.cat([pooled, gru_b], dim=-1)).squeeze(-1)
        return edge_logits, no_op, value, new_hidden

    def init_hidden(self, B):
        return torch.zeros(B, self.gru_dim, device=DEVICE)


# ===================================================
# Vec env with 4-perspective observation buffers
# ===================================================
class VecEnv:
    def __init__(self, n_envs, n_nodes=N_NODES_FIXED, base_seed=0):
        self.n = n_envs
        self.n_nodes = n_nodes
        self.envs: List[CellEnv] = []
        for i in range(n_envs):
            e = CellEnv(n_nodes=n_nodes, seed=base_seed + i)
            self._reset_until_fixed(e)
            self.envs.append(e)
        self.F_dim = self.envs[0].observe(0)['node_features'].shape[1]
        pin = torch.cuda.is_available()
        # One nf / va buffer per perspective (slot 0..3); adj is perspective-independent.
        self.nf_bufs = [torch.zeros(n_envs, n_nodes, self.F_dim, dtype=torch.float32, pin_memory=pin)
                        for _ in range(N_PLAYERS)]
        self.am_buf  = torch.zeros(n_envs, n_nodes, n_nodes, dtype=torch.float32, pin_memory=pin)
        self.va_bufs = [torch.zeros(n_envs, n_nodes * n_nodes, dtype=torch.bool, pin_memory=pin)
                        for _ in range(N_PLAYERS)]
        self.observe_slots = list(range(N_PLAYERS))   # which perspectives to compute
        self._refresh_all()
        self.completed = []
        self._ep_r = np.zeros(n_envs)
        self._ep_l = np.zeros(n_envs, dtype=int)

    def _reset_until_fixed(self, env, max_tries=80):
        for _ in range(max_tries):
            env.reset(seed=int(np.random.randint(1e9)))
            if env.N == self.n_nodes: return
        raise RuntimeError(f"Cannot reach N={self.n_nodes}")

    def _write_obs(self, i, env):
        self.am_buf[i].copy_(torch.from_numpy(env.adj_mat.astype(np.float32)))
        for p in self.observe_slots:
            obs_p = env.observe(p)
            self.nf_bufs[p][i].copy_(torch.from_numpy(obs_p['node_features']))
            self.va_bufs[p][i].copy_(torch.from_numpy(obs_p['valid_actions'].reshape(-1)))

    def _refresh_all(self):
        for i, e in enumerate(self.envs):
            self._write_obs(i, e)

    def set_active_slots(self, slots):
        """Set which slots need NN observations (skips obs for heuristic slots)."""
        self.observe_slots = sorted(set([0] + list(slots)))

    def step(self, action_pairs_per_slot: Dict[int, list]):
        rewards = np.zeros(self.n, dtype=np.float32)
        dones   = np.zeros(self.n, dtype=bool)
        for i, env in enumerate(self.envs):
            opp = {p: action_pairs_per_slot[p][i] for p in range(1, N_PLAYERS)}
            _, r, d, info = env.step(action_pairs_per_slot[0][i], opp)
            rewards[i] = r; dones[i] = d
            self._ep_r[i] += r; self._ep_l[i] += 1
            if d:
                self.completed.append((self._ep_r[i], self._ep_l[i], bool(info.get('is_leader', False))))
                self._ep_r[i] = 0; self._ep_l[i] = 0
                self._reset_until_fixed(env)
            self._write_obs(i, env)
        return rewards, dones

    def gpu_obs(self, perspective):
        nf = self.nf_bufs[perspective].to(DEVICE, non_blocking=True)
        am = self.am_buf.to(DEVICE, non_blocking=True)
        va = self.va_bufs[perspective].to(DEVICE, non_blocking=True)
        return nf, am, va


# ===================================================
# League pool: rolling set of frozen old checkpoints
# ===================================================
class LeaguePool:
    def __init__(self, in_dim, ckpt_dir, max_size=LEAGUE_MAX):
        self.in_dim = in_dim
        self.dir = ckpt_dir
        self.max_size = max_size
        os.makedirs(ckpt_dir, exist_ok=True)
        self.paths = sorted(glob.glob(f"{ckpt_dir}/ckpt_*.pt"))
        self.cache: Dict[str, GraphPolicy] = {}

    def __len__(self): return len(self.paths)

    def add(self, state_dict, path):
        torch.save(state_dict, path)
        self.paths.append(path)
        if len(self.paths) > self.max_size:
            removed = self.paths.pop(0)
            self.cache.pop(removed, None)

    def get(self, path) -> GraphPolicy:
        if path not in self.cache:
            pol = GraphPolicy(self.in_dim).to(DEVICE).eval()
            sd = torch.load(path, map_location=DEVICE)
            pol.load_state_dict(sd)
            self.cache[path] = pol
            # Trim cache
            while len(self.cache) > 8:
                oldest = next(iter(self.cache))
                if oldest != path: del self.cache[oldest]
                else: break
        return self.cache[path]

    def sample(self) -> Optional[GraphPolicy]:
        if not self.paths: return None
        return self.get(random.choice(self.paths))


# ===================================================
# Action helpers
# ===================================================
def _amp_ctx():
    return torch.amp.autocast('cuda') if (USE_AMP and DEVICE.type == 'cuda') else nullcontext()


def policy_actions(pol, nf, am, vm, hidden, B, N):
    with torch.no_grad(), _amp_ctx():
        el, nop, v, new_h = pol(nf, am, hidden)
        flat = el.float().reshape(B, N*N).masked_fill(~vm, -1e9)
        logits = torch.cat([flat, nop.float().unsqueeze(1)], dim=1)
        log_probs = F.log_softmax(logits, dim=-1)
        actions = torch.multinomial(log_probs.exp(), 1).squeeze(-1)
        log_prob = log_probs.gather(1, actions.unsqueeze(-1)).squeeze(-1)
    return actions, new_h, log_prob, v


def actions_to_pairs(actions_cpu, N):
    return [None if int(a) == N*N else (int(a)//N, int(a)%N) for a in actions_cpu]


def heuristic_pairs(envs, slot):
    return [env._heuristic_action(slot) for env in envs]


def sample_opp_specs(latest, league):
    """Per iteration, decide each non-agent slot's opponent."""
    specs = {}
    for slot in range(1, N_PLAYERS):
        r = random.random()
        if r < P_MIRROR:
            specs[slot] = ('mirror', latest)
        elif r < P_MIRROR + P_POOL and len(league) > 0:
            specs[slot] = ('pool', league.sample())
        else:
            specs[slot] = ('heuristic', None)
    return specs


# ===================================================
# Rollout
# ===================================================
def collect_rollout(vec, agent, opp_specs, n_steps, agent_hidden=None):
    B, N, F_d = vec.n, vec.n_nodes, vec.F_dim
    if agent_hidden is None:
        agent_hidden = agent.init_hidden(B)
    opp_hidden = {slot: agent.init_hidden(B) for slot in range(1, N_PLAYERS)}

    # Tell vec env which perspectives to compute (skip heuristic-only)
    nn_slots = [s for s, (k, _) in opp_specs.items() if k != 'heuristic']
    vec.set_active_slots(nn_slots)

    nf_st = torch.zeros(n_steps, B, N, F_d)
    am_st = torch.zeros(n_steps, B, N, N)
    h_st  = torch.zeros(n_steps, B, agent_hidden.size(-1))
    a_st  = torch.zeros(n_steps, B, dtype=torch.long)
    lp_st = torch.zeros(n_steps, B)
    v_st  = torch.zeros(n_steps, B)
    r_st  = torch.zeros(n_steps, B)
    d_st  = torch.zeros(n_steps, B)
    vm_st = torch.zeros(n_steps, B, N*N, dtype=torch.bool)

    for t in range(n_steps):
        nf_st[t].copy_(vec.nf_bufs[0])
        am_st[t].copy_(vec.am_buf)
        vm_st[t].copy_(vec.va_bufs[0])
        h_st[t] = agent_hidden.cpu()

        # Agent action
        nf, am, vm = vec.gpu_obs(0)
        a_t, agent_hidden_new, lp_t, v_t = policy_actions(agent, nf, am, vm, agent_hidden, B, N)
        a_st[t] = a_t.cpu(); lp_st[t] = lp_t.cpu(); v_st[t] = v_t.cpu()

        action_pairs = {0: actions_to_pairs(a_t.cpu().numpy(), N)}
        for slot, (kind, pol) in opp_specs.items():
            if kind == 'heuristic':
                action_pairs[slot] = heuristic_pairs(vec.envs, slot)
            else:
                nf_p, am_p, vm_p = vec.gpu_obs(slot)
                opp_a, opp_hidden[slot], _, _ = policy_actions(pol, nf_p, am_p, vm_p, opp_hidden[slot], B, N)
                action_pairs[slot] = actions_to_pairs(opp_a.cpu().numpy(), N)

        rewards, dones = vec.step(action_pairs)
        r_st[t] = torch.from_numpy(rewards)
        d_st[t] = torch.from_numpy(dones.astype(np.float32))

        agent_hidden = agent_hidden_new
        if dones.any():
            done_t = torch.from_numpy(dones).to(DEVICE)
            agent_hidden = torch.where(done_t.unsqueeze(-1), torch.zeros_like(agent_hidden), agent_hidden)
            for slot in opp_hidden:
                opp_hidden[slot] = torch.where(done_t.unsqueeze(-1), torch.zeros_like(opp_hidden[slot]), opp_hidden[slot])

    return ({'nf':nf_st,'am':am_st,'hidden':h_st,'action':a_st,
             'log_prob':lp_st,'value':v_st,'reward':r_st,'done':d_st,'vmask':vm_st},
            agent_hidden)


def compute_gae(bag, last_value, gamma=0.99, lam=0.95):
    rewards, values, dones = bag['reward'], bag['value'], bag['done']
    T, B = rewards.shape
    advs = torch.zeros_like(rewards)
    gae = torch.zeros(B); next_v = last_value.cpu()
    for t in reversed(range(T)):
        nonterm = 1.0 - dones[t]
        delta = rewards[t] + gamma * next_v * nonterm - values[t]
        gae   = delta + gamma * lam * nonterm * gae
        advs[t] = gae; next_v = values[t]
    return advs, advs + values


# ===================================================
# PPO update (same as train_fast)
# ===================================================
def ppo_update(policy, optim, scaler, bag, advs, rets,
               epochs=PPO_EPOCHS, mb_size=PPO_MB_SIZE,
               clip=0.2, vf_coef=0.5, ent_coef=0.02):
    T, B = bag['reward'].shape
    N = bag['nf'].size(2); Total = T * B
    nf  = bag['nf'].reshape(Total, N, -1)
    am  = bag['am'].reshape(Total, N, N)
    hi  = bag['hidden'].reshape(Total, -1)
    act = bag['action'].reshape(Total)
    old_lp = bag['log_prob'].reshape(Total)
    vm  = bag['vmask'].reshape(Total, N*N)
    advs_f = advs.reshape(Total); rets_f = rets.reshape(Total)
    advs_f = (advs_f - advs_f.mean()) / (advs_f.std() + 1e-8)

    idx = np.arange(Total)
    s = {'pi':0., 'v':0., 'ent':0., 'n':0}
    use_amp = USE_AMP and DEVICE.type == 'cuda'
    for _ in range(epochs):
        np.random.shuffle(idx)
        for st in range(0, Total, mb_size):
            mb = torch.from_numpy(idx[st:st+mb_size]).long()
            args = [nf[mb], am[mb], hi[mb], act[mb], old_lp[mb], vm[mb], advs_f[mb], rets_f[mb]]
            args = [x.to(DEVICE, non_blocking=True) for x in args]
            nf_mb, am_mb, hi_mb, act_mb, old_lp_mb, vm_mb, advs_mb, rets_mb = args

            with (torch.amp.autocast('cuda') if use_amp else nullcontext()):
                el, nop, v, _ = policy(nf_mb, am_mb, hi_mb)
                flat = el.float().reshape(el.size(0), N*N).masked_fill(~vm_mb, -1e9)
                logits = torch.cat([flat, nop.float().unsqueeze(1)], dim=1)
                log_probs = F.log_softmax(logits, dim=-1)
                new_lp = log_probs.gather(1, act_mb.unsqueeze(-1)).squeeze(-1)
                ent = -(log_probs.exp() * log_probs).sum(-1).mean()
                ratio = (new_lp - old_lp_mb).exp()
                pi_loss = -torch.min(ratio * advs_mb,
                                     torch.clamp(ratio, 1-clip, 1+clip) * advs_mb).mean()
                v_loss = F.mse_loss(v, rets_mb)
                loss = pi_loss + vf_coef * v_loss - ent_coef * ent

            optim.zero_grad(set_to_none=True)
            if scaler is not None:
                scaler.scale(loss).backward()
                scaler.unscale_(optim)
                torch.nn.utils.clip_grad_norm_(policy.parameters(), 0.5)
                scaler.step(optim); scaler.update()
            else:
                loss.backward()
                torch.nn.utils.clip_grad_norm_(policy.parameters(), 0.5)
                optim.step()
            s['pi'] += pi_loss.item(); s['v'] += v_loss.item()
            s['ent'] += ent.item(); s['n'] += 1
    return {k: v/max(1, s['n']) for k, v in [('pi',s['pi']), ('v',s['v']), ('ent',s['ent'])]}


# ===================================================
# Main
# ===================================================
def main(iterations=600):
    os.makedirs(LEAGUE_DIR, exist_ok=True)
    print(f"Init {N_ENVS} envs (N={N_NODES_FIXED})...")
    vec = VecEnv(N_ENVS)
    print(f"Feature dim: {vec.F_dim}")

    agent = GraphPolicy(vec.F_dim).to(DEVICE)
    if RESUME_FROM and os.path.exists(RESUME_FROM):
        sd = torch.load(RESUME_FROM, map_location=DEVICE)
        agent.load_state_dict(sd)
        print(f"Resumed agent from {RESUME_FROM}")
    else:
        print("Starting agent fresh (no resume file)")

    if USE_COMPILE and hasattr(torch, 'compile'):
        try:
            agent = torch.compile(agent, mode='default')
            print("torch.compile enabled")
        except Exception as e:
            print(f"compile skipped: {e}")

    optim_ = torch.optim.AdamW(
        agent._orig_mod.parameters() if hasattr(agent, '_orig_mod') else agent.parameters(),
        lr=LR
    )
    scaler = torch.amp.GradScaler('cuda') if (USE_AMP and DEVICE.type == 'cuda') else None
    league = LeaguePool(vec.F_dim, LEAGUE_DIR)
    print(f"League pool: {len(league)} checkpoints loaded")

    t0 = time.time()
    total = 0
    win_log = deque(maxlen=400)
    agent_hidden = None

    # Determine starting iteration index from existing ckpts (continue numbering)
    existing_iters = []
    for p in league.paths:
        try:
            existing_iters.append(int(os.path.basename(p).split('_')[1].split('.')[0]))
        except: pass
    base_iter = max(existing_iters) if existing_iters else 0
    print(f"Continuing from iter offset {base_iter}")

    for it in range(1, iterations + 1):
        opp_specs = sample_opp_specs(agent, league)
        bag, last_h = collect_rollout(vec, agent, opp_specs, N_STEPS, agent_hidden)
        agent_hidden = last_h.detach()

        nf, am, _ = vec.gpu_obs(0)
        with torch.no_grad(), _amp_ctx():
            _, _, last_v, _ = agent(nf, am, agent_hidden)
        advs, rets = compute_gae(bag, last_v.cpu().float())
        st = ppo_update(agent, optim_, scaler, bag, advs, rets)

        total += N_ENVS * N_STEPS
        for _, _, w in vec.completed: win_log.append(int(w))
        vec.completed.clear()

        if it == 1 or it % 5 == 0:
            elapsed = time.time() - t0
            sps = total / elapsed
            wr = float(np.mean(win_log)) if win_log else 0.0
            opp_summary = ' '.join(k[0] for _, (k, _) in opp_specs.items())
            print(f"[{it:4d}] {total/1e6:5.2f}M | {sps:6.0f} st/s | win {wr:5.1%} | "
                  f"pi {st['pi']:+.3f} v {st['v']:.3f} ent {st['ent']:.2f} | opps [{opp_summary}] | pool {len(league)}")

        if it % SAVE_EVERY == 0:
            sd = (agent._orig_mod.state_dict() if hasattr(agent, '_orig_mod') else agent.state_dict())
            sd_cpu = {k: v.detach().cpu().clone() for k, v in sd.items()}
            new_path = f'{LEAGUE_DIR}/ckpt_{base_iter + it:06d}.pt'
            league.add(sd_cpu, new_path)

    # Final
    sd = (agent._orig_mod.state_dict() if hasattr(agent, '_orig_mod') else agent.state_dict())
    torch.save({k: v.detach().cpu() for k, v in sd.items()}, f'{LEAGUE_DIR}/final.pt')
    print(f"Done. {total/1e6:.1f}M steps in {(time.time()-t0)/60:.1f} min. "
          f"Final pool: {len(league)} ckpts.")


main(iterations=600)
