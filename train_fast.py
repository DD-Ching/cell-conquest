"""
train_fast.py — GPU-saturated PPO training for Cell Conquest.

Run on Kaggle (after uploading cell_env.py as dataset 'envpyy'):
    !pip install -q torch numpy
    %run /kaggle/input/<this-dataset>/train_fast.py

Or paste the cells directly into a notebook. Defaults target ~25-40K steps/sec
on T4 with GPU at 70-90% utilization.
"""
from __future__ import annotations
import sys
# Adjust this if your env file lives elsewhere
sys.path.insert(0, '/kaggle/input/envpyy')

import os, time
from contextlib import nullcontext
from collections import deque
from typing import List
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from cell_env import CellEnv, N_PLAYERS, NEUTRAL

# ------------------- Speed flags -------------------
torch.backends.cudnn.benchmark = True
torch.set_float32_matmul_precision('high')
DEVICE = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
print(f"Device: {DEVICE}, AMP: {DEVICE.type == 'cuda'}")

# ------------------- Tunables -------------------
N_NODES_FIXED = 40
N_ENVS        = 256       # raise to 384/512 if GPU memory allows
N_STEPS       = 64
HIDDEN        = 96
GRU_DIM       = 96
USE_AMP       = True
USE_COMPILE   = True
PPO_MB_SIZE   = 2048
PPO_EPOCHS    = 4
LR            = 3e-4
BC_STEPS      = 3000      # behavioral cloning warmup: imitate heuristic before PPO. 0 = skip.
BC_LR         = 1e-3      # higher LR for BC since it's just supervised CE


# ===================================================
# Policy
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
        h = self.gc1(h, adj_norm)
        h = self.gc2(h, adj_norm)
        h = self.gc3(h, adj_norm)
        pmean = h.mean(dim=1)
        pmax  = h.max(dim=1).values
        pooled = torch.cat([pmean, pmax], dim=-1)
        new_hidden = self.gru(pooled, hidden)
        gru_b = new_hidden
        h_q = torch.cat([h, gru_b.unsqueeze(1).expand(-1, h.size(1), -1)], dim=-1)
        q = self.actor_q(h_q)
        k = self.actor_k(h)
        edge_logits = q @ k.transpose(-2, -1)
        no_op_logit = self.no_op_head(torch.cat([pmean, gru_b], dim=-1)).squeeze(-1)
        value = self.critic(torch.cat([pooled, gru_b], dim=-1)).squeeze(-1)
        return edge_logits, no_op_logit, value, new_hidden

    def init_hidden(self, B):
        return torch.zeros(B, self.gru_dim, device=DEVICE)


# ===================================================
# Vectorized env (pinned-memory buffers → async GPU transfer)
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
        F_dim = self.envs[0].observe(0)['node_features'].shape[1]
        self.F_dim = F_dim
        pin = torch.cuda.is_available()
        self.nf_buf = torch.zeros(n_envs, n_nodes, F_dim,  dtype=torch.float32, pin_memory=pin)
        self.am_buf = torch.zeros(n_envs, n_nodes, n_nodes, dtype=torch.float32, pin_memory=pin)
        self.va_buf = torch.zeros(n_envs, n_nodes * n_nodes, dtype=torch.bool,  pin_memory=pin)
        self._refresh_all()
        self.completed = []
        self._ep_r = np.zeros(n_envs)
        self._ep_l = np.zeros(n_envs, dtype=int)

    def _reset_until_fixed(self, env, max_tries=80):
        for _ in range(max_tries):
            env.reset(seed=int(np.random.randint(1e9)))
            if env.N == self.n_nodes: return
        raise RuntimeError(f"Cannot reach N={self.n_nodes}")

    def _write_obs_from_dict(self, i, obs):
        self.nf_buf[i].copy_(torch.from_numpy(obs['node_features']))
        self.am_buf[i].copy_(torch.from_numpy(obs['adj_mat'].astype(np.float32)))
        self.va_buf[i].copy_(torch.from_numpy(obs['valid_actions'].reshape(-1)))

    def _refresh_all(self):
        for i, e in enumerate(self.envs):
            self._write_obs_from_dict(i, e.observe(0))

    def step(self, p0_actions):
        rewards = np.zeros(self.n, dtype=np.float32)
        dones   = np.zeros(self.n, dtype=bool)
        for i, env in enumerate(self.envs):
            opp = {p: env._heuristic_action(p) for p in range(1, N_PLAYERS)}
            obs, r, d, info = env.step(p0_actions[i], opp)
            rewards[i] = r; dones[i] = d
            self._ep_r[i] += r; self._ep_l[i] += 1
            if d:
                # Win = leader at end (sole survivor OR top node count at timeout)
                self.completed.append((self._ep_r[i], self._ep_l[i], bool(info.get('is_leader', False))))
                self._ep_r[i] = 0; self._ep_l[i] = 0
                self._reset_until_fixed(env)
                obs = env.observe(0)
            self._write_obs_from_dict(i, obs)
        return rewards, dones

    def gpu_obs(self):
        nf = self.nf_buf.to(DEVICE, non_blocking=True)
        am = self.am_buf.to(DEVICE, non_blocking=True)
        va = self.va_buf.to(DEVICE, non_blocking=True)
        return nf, am, va


# ===================================================
# Rollout + GAE
# ===================================================
def collect_rollout(vec, policy, n_steps):
    B, N, F_d = vec.n, vec.n_nodes, vec.F_dim
    hidden = policy.init_hidden(B)
    nf_st = torch.zeros(n_steps, B, N, F_d)
    am_st = torch.zeros(n_steps, B, N, N)
    h_st  = torch.zeros(n_steps, B, policy.gru_dim)
    a_st  = torch.zeros(n_steps, B, dtype=torch.long)
    lp_st = torch.zeros(n_steps, B)
    v_st  = torch.zeros(n_steps, B)
    r_st  = torch.zeros(n_steps, B)
    d_st  = torch.zeros(n_steps, B)
    vm_st = torch.zeros(n_steps, B, N*N, dtype=torch.bool)

    use_amp = USE_AMP and DEVICE.type == 'cuda'

    for t in range(n_steps):
        nf_st[t].copy_(vec.nf_buf)
        am_st[t].copy_(vec.am_buf)
        vm_st[t].copy_(vec.va_buf)
        h_st[t] = hidden.cpu()

        nf, am, vm = vec.gpu_obs()
        amp_ctx = torch.amp.autocast('cuda') if use_amp else nullcontext()
        with torch.no_grad(), amp_ctx:
            el, nop, v, new_hidden = policy(nf, am, hidden)
            # cast to fp32 BEFORE masking — -1e9 overflows fp16
            flat = el.float().reshape(B, N*N).masked_fill(~vm, -1e9)
            logits = torch.cat([flat, nop.float().unsqueeze(1)], dim=1)
            log_probs = F.log_softmax(logits, dim=-1)
            actions = torch.multinomial(log_probs.exp(), 1).squeeze(-1)
            log_prob = log_probs.gather(1, actions.unsqueeze(-1)).squeeze(-1)

        a_cpu = actions.cpu().numpy()
        pairs = [None if int(a) == N*N else (int(a)//N, int(a)%N) for a in a_cpu]
        rewards, dones = vec.step(pairs)

        a_st[t]  = actions.cpu()
        lp_st[t] = log_prob.cpu()
        v_st[t]  = v.cpu()
        r_st[t]  = torch.from_numpy(rewards)
        d_st[t]  = torch.from_numpy(dones.astype(np.float32))

        hidden = new_hidden
        if dones.any():
            done_t = torch.from_numpy(dones).to(DEVICE)
            hidden = torch.where(done_t.unsqueeze(-1), torch.zeros_like(hidden), hidden)

    return {'nf':nf_st,'am':am_st,'hidden':h_st,'action':a_st,
            'log_prob':lp_st,'value':v_st,'reward':r_st,'done':d_st,'vmask':vm_st}, hidden


def compute_gae(bag, last_value, gamma=0.99, lam=0.95):
    rewards, values, dones = bag['reward'], bag['value'], bag['done']
    T, B = rewards.shape
    advs = torch.zeros_like(rewards)
    gae  = torch.zeros(B)
    next_v = last_value.cpu()
    for t in reversed(range(T)):
        nonterm = 1.0 - dones[t]
        delta = rewards[t] + gamma * next_v * nonterm - values[t]
        gae   = delta + gamma * lam * nonterm * gae
        advs[t] = gae
        next_v = values[t]
    rets = advs + values
    return advs, rets


# ===================================================
# PPO update (AMP + big batch)
# ===================================================
def ppo_update(policy, optim, scaler, bag, advs, rets,
               epochs=PPO_EPOCHS, mb_size=PPO_MB_SIZE,
               clip=0.2, vf_coef=0.5, ent_coef=0.01):
    T, B = bag['reward'].shape
    N = bag['nf'].size(2)
    Total = T * B
    nf  = bag['nf'].reshape(Total, N, -1)
    am  = bag['am'].reshape(Total, N, N)
    hi  = bag['hidden'].reshape(Total, -1)
    act = bag['action'].reshape(Total)
    old_lp = bag['log_prob'].reshape(Total)
    vm  = bag['vmask'].reshape(Total, N*N)
    advs_f = advs.reshape(Total)
    rets_f = rets.reshape(Total)
    advs_f = (advs_f - advs_f.mean()) / (advs_f.std() + 1e-8)

    idx = np.arange(Total)
    s = {'pi':0., 'v':0., 'ent':0., 'n':0}
    use_amp = USE_AMP and DEVICE.type == 'cuda'

    for _ in range(epochs):
        np.random.shuffle(idx)
        for st in range(0, Total, mb_size):
            mb = torch.from_numpy(idx[st:st+mb_size]).long()
            nf_mb = nf[mb].to(DEVICE, non_blocking=True)
            am_mb = am[mb].to(DEVICE, non_blocking=True)
            hi_mb = hi[mb].to(DEVICE, non_blocking=True)
            act_mb = act[mb].to(DEVICE, non_blocking=True)
            old_lp_mb = old_lp[mb].to(DEVICE, non_blocking=True)
            vm_mb = vm[mb].to(DEVICE, non_blocking=True)
            advs_mb = advs_f[mb].to(DEVICE, non_blocking=True)
            rets_mb = rets_f[mb].to(DEVICE, non_blocking=True)

            with (torch.amp.autocast('cuda') if use_amp else nullcontext()):
                el, nop, v, _ = policy(nf_mb, am_mb, hi_mb)
                flat = el.float().reshape(el.size(0), N*N).masked_fill(~vm_mb, -1e9)
                logits = torch.cat([flat, nop.float().unsqueeze(1)], dim=1)
                log_probs = F.log_softmax(logits, dim=-1)
                new_lp = log_probs.gather(1, act_mb.unsqueeze(-1)).squeeze(-1)
                ent = -(log_probs.exp() * log_probs).sum(-1).mean()
                ratio = (new_lp - old_lp_mb).exp()
                s1 = ratio * advs_mb
                s2 = torch.clamp(ratio, 1-clip, 1+clip) * advs_mb
                pi_loss = -torch.min(s1, s2).mean()
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
# Behavioral cloning warmup — imitate heuristic
# ===================================================
def bc_warmup(policy, vec, n_steps=BC_STEPS, lr=BC_LR):
    """Supervised CE: agent learns to predict heuristic's next action.
    Drives env with heuristic so we see realistic mid-game states.
    Result: policy starts PPO with sensible behavior, not pure noise."""
    optim_ = torch.optim.AdamW(policy.parameters(), lr=lr)
    use_amp = USE_AMP and DEVICE.type == 'cuda'
    scaler = torch.amp.GradScaler('cuda') if use_amp else None
    hidden = policy.init_hidden(vec.n)
    N = vec.n_nodes
    losses, accs = [], []
    t0 = time.time()

    for step in range(n_steps):
        # What would heuristic do as slot 0? (CE target)
        h_p0 = [env._heuristic_action(0) for env in vec.envs]
        targets = np.fromiter(
            (N * N if a is None else (a[0] * N + a[1]) for a in h_p0),
            dtype=np.int64, count=vec.n,
        )
        targets_t = torch.from_numpy(targets).to(DEVICE)

        nf, am, vm = vec.gpu_obs()
        with (torch.amp.autocast('cuda') if use_amp else nullcontext()):
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

        # Drive env with heuristic so states evolve naturally
        _, dones = vec.step(h_p0)
        hidden = new_hidden.detach()
        if dones.any():
            done_t = torch.from_numpy(dones).to(DEVICE)
            hidden = torch.where(done_t.unsqueeze(-1), torch.zeros_like(hidden), hidden)

        if step == 0 or (step + 1) % 200 == 0:
            recent_l = float(np.mean(losses[-200:]))
            recent_a = float(np.mean(accs[-200:]))
            print(f"  BC [{step+1:5d}/{n_steps}] loss {recent_l:.3f}  acc {recent_a:5.1%}  ({time.time()-t0:5.0f}s)")
    print(f"BC done in {time.time()-t0:.0f}s. final loss {float(np.mean(losses[-200:])):.3f}  acc {float(np.mean(accs[-200:])):.1%}")


# ===================================================
# Main loop
# ===================================================
def train(iterations=500, save_every=50, ckpt_dir='/kaggle/working/league'):
    os.makedirs(ckpt_dir, exist_ok=True)
    print(f"Init {N_ENVS} envs (N={N_NODES_FIXED})...")
    vec = VecEnv(N_ENVS)
    print(f"Feature dim: {vec.F_dim}")

    policy = GraphPolicy(vec.F_dim).to(DEVICE)
    if USE_COMPILE and hasattr(torch, 'compile'):
        try:
            policy = torch.compile(policy, mode='default')
            print("torch.compile enabled")
        except Exception as e:
            print(f"compile skipped: {e}")
    # BC warmup so PPO doesn't start from random
    if BC_STEPS > 0:
        print(f"\n=== BC warmup: imitate heuristic for {BC_STEPS} steps ===")
        bc_warmup(policy, vec, n_steps=BC_STEPS)
        print("=== PPO self-play begins ===\n")

    optim_ = torch.optim.AdamW(policy.parameters(), lr=LR)
    scaler = torch.amp.GradScaler('cuda') if (USE_AMP and DEVICE.type == 'cuda') else None

    t0 = time.time()
    total = 0
    win_log = deque(maxlen=400)

    for it in range(1, iterations + 1):
        bag, last_h = collect_rollout(vec, policy, N_STEPS)
        nf, am, _ = vec.gpu_obs()
        with torch.no_grad(), (torch.amp.autocast('cuda') if (USE_AMP and DEVICE.type == 'cuda') else nullcontext()):
            _, _, last_v, _ = policy(nf, am, last_h)
        advs, rets = compute_gae(bag, last_v.cpu().float())
        st = ppo_update(policy, optim_, scaler, bag, advs, rets)

        total += N_ENVS * N_STEPS
        for _, _, w in vec.completed: win_log.append(int(w))
        vec.completed.clear()

        if it == 1 or it % 5 == 0:
            elapsed = time.time() - t0
            sps = total / elapsed
            wr = float(np.mean(win_log)) if win_log else 0.0
            print(f"[{it:4d}] {total/1e6:5.2f}M | {sps:7.0f} st/s | win {wr:5.1%} | "
                  f"pi {st['pi']:+.3f} v {st['v']:.3f} ent {st['ent']:.2f}")

        if it % save_every == 0:
            sd = policy._orig_mod.state_dict() if hasattr(policy, '_orig_mod') else policy.state_dict()
            torch.save(sd, f'{ckpt_dir}/ckpt_{it:06d}.pt')

    sd = policy._orig_mod.state_dict() if hasattr(policy, '_orig_mod') else policy.state_dict()
    torch.save(sd, f'{ckpt_dir}/final.pt')
    print(f"Done. {total/1e6:.1f}M steps in {(time.time()-t0)/60:.1f} min")


if __name__ == '__main__':
    train(iterations=500, save_every=50)
