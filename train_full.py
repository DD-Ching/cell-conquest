"""
train_full.py — Cell Conquest v2 comprehensive training.

Pipeline:
  1. Smoke test (verify env, policy, rollout, PPO step all work) — ~20s
  2. BC warmup (imitate heuristic) — ~5 min, gets policy to heuristic-level fast
  3. PPO + AlphaStar-style league self-play — main training, 6-8 h

Key features:
  - Variable n_active_players per env (model is player-agnostic)
  - Auto-finds cell_env.py and any final.pt across /kaggle/input
  - Resume support: if final.pt exists in input or working dir, loads as init
  - League pool grows over training; opponents = mix(mirror, pool, heuristic)
  - GPU-optimised: AMP fp16, torch.compile, pinned-memory buffers, big batch

Just run this file. Smoke test runs first; if it passes, training proceeds.
"""
from __future__ import annotations
import sys, os, time, random, glob

# --- Auto-find cell_env.py in any uploaded Kaggle dataset ---
for _p in glob.glob('/kaggle/input/*'):
    if glob.glob(f'{_p}/cell_env.py'):
        sys.path.insert(0, _p)
        print(f'cell_env from: {_p}')
        break
else:
    # fallback for local dev
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    except NameError:
        sys.path.insert(0, os.getcwd())

from contextlib import nullcontext
from collections import deque
from typing import List, Optional, Dict
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from cell_env import CellEnv, N_MAX_PLAYERS, NEUTRAL, PER_NODE_FEATURES

torch.backends.cudnn.benchmark = True
torch.set_float32_matmul_precision('high')
DEVICE = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
print(f"Device: {DEVICE}, AMP: {DEVICE.type == 'cuda'}")

# --- Auto-find resume checkpoint (any final.pt across inputs / working) ---
_finals = (glob.glob('/kaggle/input/**/final.pt', recursive=True)
           + glob.glob('/kaggle/working/league/final.pt'))
RESUME_FROM = _finals[0] if _finals else None
print(f"RESUME_FROM = {RESUME_FROM or '(none — fresh start)'}")

# ---------------- Tunables ----------------
N_NODES_FIXED   = 40
N_ENVS          = 256
N_STEPS         = 64
HIDDEN          = 96
GRU_DIM         = 96
USE_AMP         = True
USE_COMPILE     = True
PPO_MB_SIZE     = 2048
PPO_EPOCHS      = 4
LR              = 3e-4
LEAGUE_DIR      = '/kaggle/working/league'
SAVE_EVERY      = 25
LEAGUE_MAX      = 30
BC_STEPS        = 3000           # 0 to skip BC; set lower (e.g. 800) for quick test
BC_LR           = 1e-3
P_MIRROR        = 0.50
P_POOL          = 0.35
P_HEURISTIC     = 0.15
MIN_PLAYERS     = 2
MAX_PLAYERS     = 6
ITERATIONS      = 2500           # ~6-8h on T4 (interrupt anytime; ckpts saved every SAVE_EVERY iters)


# ===================================================
# Policy (player-agnostic, takes 23-dim features)
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
# Vec env with per-env variable n_active
# ===================================================
class VecEnv:
    """Each env independently samples n_active ∈ [MIN_PLAYERS, MAX_PLAYERS].
    Maintains MAX_PLAYERS obs buffers (per slot/perspective); inactive slots
    get zeroed obs but the model never sees that perspective for them."""
    def __init__(self, n_envs, n_nodes=N_NODES_FIXED, base_seed=0,
                 min_players=MIN_PLAYERS, max_players=MAX_PLAYERS):
        self.n = n_envs
        self.n_nodes = n_nodes
        self.max_players = max_players
        self.envs: List[CellEnv] = []
        for i in range(n_envs):
            e = CellEnv(n_nodes=n_nodes, min_players=min_players,
                        max_players=max_players, seed=base_seed + i)
            self._reset_until_fixed(e)
            self.envs.append(e)
        self.F_dim = self.envs[0].observe(0)['node_features'].shape[1]
        pin = torch.cuda.is_available()
        # One buffer per (slot, env). Slot 0 always active.
        self.nf_bufs = [torch.zeros(n_envs, n_nodes, self.F_dim, dtype=torch.float32, pin_memory=pin)
                        for _ in range(max_players)]
        self.am_buf  = torch.zeros(n_envs, n_nodes, n_nodes, dtype=torch.float32, pin_memory=pin)
        self.va_bufs = [torch.zeros(n_envs, n_nodes * n_nodes, dtype=torch.bool, pin_memory=pin)
                        for _ in range(max_players)]
        # active_mask[slot][env] = True if env has that slot
        self.active_mask = [torch.zeros(n_envs, dtype=torch.bool) for _ in range(max_players)]
        self.observe_slots = list(range(max_players))
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
        for p in range(self.max_players):
            active = (p < env.n_active)
            self.active_mask[p][i] = active
            if active and p in self.observe_slots:
                obs_p = env.observe(p)
                self.nf_bufs[p][i].copy_(torch.from_numpy(obs_p['node_features']))
                self.va_bufs[p][i].copy_(torch.from_numpy(obs_p['valid_actions'].reshape(-1)))
            else:
                # Zero out (model would mask these via active_mask anyway)
                self.nf_bufs[p][i].zero_()
                self.va_bufs[p][i].zero_()

    def _refresh_all(self):
        for i, e in enumerate(self.envs):
            self._write_obs(i, e)

    def set_active_slots(self, slots):
        """Limit which slots we recompute obs for (perf)."""
        self.observe_slots = sorted(set([0] + list(slots)))

    def step(self, action_pairs_per_slot: Dict[int, list]):
        rewards = np.zeros(self.n, dtype=np.float32)
        dones   = np.zeros(self.n, dtype=bool)
        for i, env in enumerate(self.envs):
            # Only pass actions for active slots of this env
            opp = {}
            for p in range(1, env.n_active):
                if p in action_pairs_per_slot:
                    opp[p] = action_pairs_per_slot[p][i]
            _, r, d, info = env.step(action_pairs_per_slot[0][i], opp)
            rewards[i] = r; dones[i] = d
            self._ep_r[i] += r; self._ep_l[i] += 1
            if d:
                self.completed.append((self._ep_r[i], self._ep_l[i],
                                       bool(info.get('is_leader', False)),
                                       int(info.get('n_active', 0))))
                self._ep_r[i] = 0; self._ep_l[i] = 0
                self._reset_until_fixed(env)
            self._write_obs(i, env)
        return rewards, dones

    def gpu_obs(self, perspective):
        nf = self.nf_bufs[perspective].to(DEVICE, non_blocking=True)
        am = self.am_buf.to(DEVICE, non_blocking=True)
        va = self.va_bufs[perspective].to(DEVICE, non_blocking=True)
        return nf, am, va

    def gpu_active(self, perspective):
        return self.active_mask[perspective].to(DEVICE, non_blocking=True)


# ===================================================
# League pool
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
            sd = torch.load(path, map_location=DEVICE, weights_only=True)
            pol.load_state_dict(sd)
            self.cache[path] = pol
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


def policy_actions(pol, nf, am, vm, hidden, B, N, sample=True):
    with torch.no_grad(), _amp_ctx():
        el, nop, v, new_h = pol(nf, am, hidden)
        flat = el.float().reshape(B, N*N).masked_fill(~vm, -1e9)
        logits = torch.cat([flat, nop.float().unsqueeze(1)], dim=1)
        log_probs = F.log_softmax(logits, dim=-1)
        if sample:
            actions = torch.multinomial(log_probs.exp(), 1).squeeze(-1)
        else:
            actions = log_probs.argmax(dim=-1)
        log_prob = log_probs.gather(1, actions.unsqueeze(-1)).squeeze(-1)
    return actions, new_h, log_prob, v


def actions_to_pairs(actions_cpu, N):
    return [None if int(a) == N*N else (int(a)//N, int(a)%N) for a in actions_cpu]


def heuristic_pairs_for_slot(envs, slot):
    out = []
    for env in envs:
        out.append(env._heuristic_action(slot) if slot < env.n_active else None)
    return out


def sample_opp_specs(latest, league, max_slots):
    """For each non-agent slot up to max_slots-1, pick an opponent type."""
    specs = {}
    for slot in range(1, max_slots):
        r = random.random()
        if r < P_MIRROR:
            specs[slot] = ('mirror', latest)
        elif r < P_MIRROR + P_POOL and len(league) > 0:
            specs[slot] = ('pool', league.sample())
        else:
            specs[slot] = ('heuristic', None)
    return specs


# ===================================================
# BC warmup
# ===================================================
def bc_warmup(policy, vec, n_steps=BC_STEPS, lr=BC_LR):
    if n_steps <= 0:
        print("BC skipped"); return
    optim_ = torch.optim.AdamW(
        policy._orig_mod.parameters() if hasattr(policy, '_orig_mod') else policy.parameters(),
        lr=lr)
    use_amp = USE_AMP and DEVICE.type == 'cuda'
    scaler = torch.amp.GradScaler('cuda') if use_amp else None
    hidden = policy.init_hidden(vec.n)
    N = vec.n_nodes
    losses, accs = [], []
    t0 = time.time()
    print(f"\n=== BC warmup ({n_steps} steps, imitating heuristic) ===")

    for step in range(n_steps):
        # Heuristic action for slot 0 (the agent's perspective in each env)
        h_p0 = [env._heuristic_action(0) for env in vec.envs]
        targets = np.fromiter(
            (N * N if a is None else (a[0] * N + a[1]) for a in h_p0),
            dtype=np.int64, count=vec.n,
        )
        targets_t = torch.from_numpy(targets).to(DEVICE)

        nf, am, vm = vec.gpu_obs(0)
        with _amp_ctx():
            el, nop, v, new_hidden = policy(nf, am, hidden)
            flat = el.float().reshape(vec.n, N*N).masked_fill(~vm, -1e9)
            logits = torch.cat([flat, nop.float().unsqueeze(1)], dim=1)
            log_probs = F.log_softmax(logits, dim=-1)
            loss = F.nll_loss(log_probs, targets_t)

        optim_.zero_grad(set_to_none=True)
        if scaler is not None:
            scaler.scale(loss).backward()
            scaler.unscale_(optim_)
            torch.nn.utils.clip_grad_norm_(policy.parameters(), 0.5)
            scaler.step(optim_); scaler.update()
        else:
            loss.backward()
            torch.nn.utils.clip_grad_norm_(policy.parameters(), 0.5)
            optim_.step()

        with torch.no_grad():
            preds = log_probs.argmax(dim=-1)
            acc = (preds == targets_t).float().mean().item()
        losses.append(loss.item()); accs.append(acc)

        # Drive envs with heuristic across all active slots
        action_pairs = {0: h_p0}
        for p in range(1, vec.max_players):
            action_pairs[p] = heuristic_pairs_for_slot(vec.envs, p)
        _, dones = vec.step(action_pairs)

        hidden = new_hidden.detach()
        if dones.any():
            done_t = torch.from_numpy(dones).to(DEVICE)
            hidden = torch.where(done_t.unsqueeze(-1), torch.zeros_like(hidden), hidden)

        if step == 0 or (step + 1) % 200 == 0:
            recent_l = float(np.mean(losses[-200:]))
            recent_a = float(np.mean(accs[-200:]))
            print(f"  BC [{step+1:5d}/{n_steps}] loss {recent_l:.3f}  acc {recent_a:5.1%}  ({time.time()-t0:5.0f}s)")
    print(f"BC done in {time.time()-t0:.0f}s. final loss {float(np.mean(losses[-200:])):.3f}  "
          f"acc {float(np.mean(accs[-200:])):.1%}")


# ===================================================
# Rollout (variable players, opponents per slot)
# ===================================================
def collect_rollout(vec, agent, opp_specs, n_steps, agent_hidden=None):
    B, N, F_d = vec.n, vec.n_nodes, vec.F_dim
    if agent_hidden is None:
        agent_hidden = agent.init_hidden(B)
    opp_hidden = {slot: agent.init_hidden(B) for slot in range(1, vec.max_players)}

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

        nf, am, vm = vec.gpu_obs(0)
        a_t, agent_hidden_new, lp_t, v_t = policy_actions(agent, nf, am, vm, agent_hidden, B, N)
        a_st[t] = a_t.cpu(); lp_st[t] = lp_t.cpu(); v_st[t] = v_t.cpu()

        action_pairs = {0: actions_to_pairs(a_t.cpu().numpy(), N)}
        for slot, (kind, pol) in opp_specs.items():
            if kind == 'heuristic':
                action_pairs[slot] = heuristic_pairs_for_slot(vec.envs, slot)
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
# PPO update
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
# Smoke test
# ===================================================
def smoke_test():
    print("\n=========================================")
    print("=== SMOKE TEST ===")
    print("=========================================")
    t0 = time.time()
    test_vec = VecEnv(8, n_nodes=N_NODES_FIXED, min_players=2, max_players=4)
    assert test_vec.F_dim == PER_NODE_FEATURES, f"Feature dim {test_vec.F_dim} != {PER_NODE_FEATURES}"
    print(f"[1/5] VecEnv built: {test_vec.n} envs, F={test_vec.F_dim}, max_players={test_vec.max_players}")

    test_pol = GraphPolicy(test_vec.F_dim).to(DEVICE)
    print(f"[2/5] Policy built: {sum(p.numel() for p in test_pol.parameters()):,} params")

    # One BC step
    bc_warmup(test_pol, test_vec, n_steps=5, lr=1e-3)
    print(f"[3/5] BC step OK")

    # Rollout
    test_league = LeaguePool(test_vec.F_dim, '/tmp/league_smoke')
    opp_specs = sample_opp_specs(test_pol, test_league, test_vec.max_players)
    bag, _ = collect_rollout(test_vec, test_pol, opp_specs, 16)
    assert bag['nf'].shape == (16, 8, N_NODES_FIXED, PER_NODE_FEATURES)
    print(f"[4/5] Rollout shapes OK: nf {tuple(bag['nf'].shape)}")

    # PPO update
    advs, rets = compute_gae(bag, torch.zeros(test_vec.n))
    test_optim = torch.optim.AdamW(test_pol.parameters(), lr=3e-4)
    scaler = torch.amp.GradScaler('cuda') if (USE_AMP and DEVICE.type == 'cuda') else None
    stats = ppo_update(test_pol, test_optim, scaler, bag, advs, rets, epochs=1, mb_size=32)
    print(f"[5/5] PPO update OK: pi {stats['pi']:+.3f} v {stats['v']:.3f} ent {stats['ent']:.2f}")

    print(f"\n=== SMOKE TEST PASSED in {time.time()-t0:.1f}s ===\n")


# ===================================================
# Main training loop
# ===================================================
def main(iterations=ITERATIONS):
    os.makedirs(LEAGUE_DIR, exist_ok=True)
    print(f"\n=== MAIN TRAINING ===")
    print(f"Init {N_ENVS} envs (N={N_NODES_FIXED}, players={MIN_PLAYERS}-{MAX_PLAYERS})...")
    vec = VecEnv(N_ENVS, n_nodes=N_NODES_FIXED, min_players=MIN_PLAYERS, max_players=MAX_PLAYERS)
    print(f"Feature dim: {vec.F_dim}")

    agent = GraphPolicy(vec.F_dim).to(DEVICE)
    if RESUME_FROM and os.path.exists(RESUME_FROM):
        try:
            sd = torch.load(RESUME_FROM, map_location=DEVICE, weights_only=True)
            # Strip torch.compile prefix if present
            if any(k.startswith('_orig_mod.') for k in sd):
                sd = {k.replace('_orig_mod.', ''): v for k, v in sd.items()}
            agent.load_state_dict(sd)
            print(f"Resumed agent from {RESUME_FROM}")
        except Exception as e:
            print(f"Resume FAILED ({e}); starting fresh")
    else:
        print("Starting agent fresh")

    # BC warmup BEFORE compile (compile traces specific shapes)
    bc_warmup(agent, vec)

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
    npl_log = deque(maxlen=400)
    agent_hidden = None

    existing_iters = []
    for p in league.paths:
        try: existing_iters.append(int(os.path.basename(p).split('_')[1].split('.')[0]))
        except: pass
    base_iter = max(existing_iters) if existing_iters else 0
    print(f"Continuing iter offset {base_iter}\n")

    for it in range(1, iterations + 1):
        opp_specs = sample_opp_specs(agent, league, vec.max_players)
        bag, last_h = collect_rollout(vec, agent, opp_specs, N_STEPS, agent_hidden)
        agent_hidden = last_h.detach()

        nf, am, _ = vec.gpu_obs(0)
        with torch.no_grad(), _amp_ctx():
            _, _, last_v, _ = agent(nf, am, agent_hidden)
        advs, rets = compute_gae(bag, last_v.cpu().float())
        st = ppo_update(agent, optim_, scaler, bag, advs, rets)

        total += N_ENVS * N_STEPS
        for _, _, w, npl in vec.completed:
            win_log.append(int(w))
            npl_log.append(npl)
        vec.completed.clear()

        if it == 1 or it % 5 == 0:
            elapsed = time.time() - t0
            sps = total / elapsed
            wr = float(np.mean(win_log)) if win_log else 0.0
            avg_npl = float(np.mean(npl_log)) if npl_log else 0.0
            opp_summary = ' '.join(k[0] for _, (k, _) in opp_specs.items())
            print(f"[{it:4d}] {total/1e6:5.2f}M | {sps:6.0f} st/s | win {wr:5.1%} "
                  f"(avg {avg_npl:.1f}P) | pi {st['pi']:+.3f} v {st['v']:.3f} ent {st['ent']:.2f} | "
                  f"opps [{opp_summary}] | pool {len(league)}")

        if it % SAVE_EVERY == 0:
            sd = (agent._orig_mod.state_dict() if hasattr(agent, '_orig_mod') else agent.state_dict())
            sd_cpu = {k: v.detach().cpu().clone() for k, v in sd.items()}
            new_path = f'{LEAGUE_DIR}/ckpt_{base_iter + it:06d}.pt'
            league.add(sd_cpu, new_path)

    sd = (agent._orig_mod.state_dict() if hasattr(agent, '_orig_mod') else agent.state_dict())
    torch.save({k: v.detach().cpu() for k, v in sd.items()}, f'{LEAGUE_DIR}/final.pt')
    print(f"\nDone. {total/1e6:.1f}M steps in {(time.time()-t0)/60:.1f} min. "
          f"Final pool: {len(league)} ckpts.")


# Entry: smoke test first, then full training
smoke_test()
main(iterations=ITERATIONS)
