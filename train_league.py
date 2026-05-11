"""
train_league.py — PPO + AlphaStar-style self-play league for Cell Conquest.

What this gives you (matches the design we discussed):
  - GraphSAGE-lite encoder + GRU recurrent state (for "猜疑" / opponent modelling).
  - Edge-attention actor (q[src] · k[dst]) — natural fit for the (src, dst) action.
  - Masked discrete action space (only legal moves get logits).
  - League pool: agent fights latest-self / sampled-old-self / heuristic in a mix,
    which prevents collapse and drives "互相廝殺無數場演化".

Run on Kaggle GPU:
    pip install torch numpy
    python train_league.py

Tunable knobs at the bottom of the file. Saves checkpoint every N iterations
to ./league/. Final policy → cell_policy_final.pt (load in inference / export to ONNX).
"""
from __future__ import annotations
import os, time, copy, random, math
from collections import deque
from dataclasses import dataclass, field
from typing import List, Dict, Tuple, Optional

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from cell_env import CellEnv, N_PLAYERS, NEUTRAL

DEVICE = torch.device('cuda' if torch.cuda.is_available() else 'cpu')

# =========================================================================
# Policy network: GraphSAGE-lite + GRU + edge-attention actor
# =========================================================================
class GraphConv(nn.Module):
    """One mean-aggregation layer: h_i' = GELU(W_self h_i + W_nbr mean(h_j over j∈N(i)))."""
    def __init__(self, dim):
        super().__init__()
        self.self_lin = nn.Linear(dim, dim)
        self.nbr_lin = nn.Linear(dim, dim)
    def forward(self, h, adj_norm):
        nbr_msg = adj_norm @ h
        return F.gelu(self.self_lin(h) + self.nbr_lin(nbr_msg))


class GraphPolicy(nn.Module):
    """Inputs: node_feats [N, F], adj_mat [N, N] bool, hidden [1, H].
       Outputs: edge_logits [N, N], no_op_logit [], value [], new_hidden [1, H]."""
    def __init__(self, in_dim: int, hidden: int = 64, gru_dim: int = 64):
        super().__init__()
        self.encode = nn.Linear(in_dim, hidden)
        self.gc1 = GraphConv(hidden)
        self.gc2 = GraphConv(hidden)
        self.gru = nn.GRUCell(hidden * 2, gru_dim)
        self.gru_dim = gru_dim
        self.actor_q = nn.Linear(hidden + gru_dim, hidden)   # source query (state-aware)
        self.actor_k = nn.Linear(hidden, hidden)              # target key
        self.no_op_head = nn.Linear(hidden + gru_dim, 1)
        self.critic = nn.Sequential(
            nn.Linear(hidden * 2 + gru_dim, hidden), nn.GELU(),
            nn.Linear(hidden, 1),
        )

    def forward(self, node_feats: torch.Tensor, adj_mat: torch.Tensor,
                hidden: torch.Tensor):
        h = F.gelu(self.encode(node_feats))
        deg = adj_mat.sum(-1, keepdim=True).clamp(min=1.0)
        adj_norm = adj_mat / deg
        h = self.gc1(h, adj_norm)
        h = self.gc2(h, adj_norm)
        pooled = torch.cat([h.mean(0), h.max(0).values], dim=0)         # [2H]
        new_hidden = self.gru(pooled.unsqueeze(0), hidden)              # [1, gru_dim]
        gru_b = new_hidden.squeeze(0)                                    # [gru_dim]
        # Source-side gets memory injected; target-side stays state-free.
        h_q = torch.cat([h, gru_b.unsqueeze(0).expand(h.size(0), -1)], dim=1)
        q = self.actor_q(h_q)
        k = self.actor_k(h)
        edge_logits = q @ k.T                                            # [N, N]
        no_op_logit = self.no_op_head(torch.cat([h.mean(0), gru_b])).squeeze(-1)
        value = self.critic(torch.cat([pooled, gru_b])).squeeze(-1)
        return edge_logits, no_op_logit, value, new_hidden

    def init_hidden(self) -> torch.Tensor:
        return torch.zeros(1, self.gru_dim, device=DEVICE)


def flat_logits(edge_logits: torch.Tensor, no_op_logit: torch.Tensor,
                valid_mask_np: np.ndarray) -> torch.Tensor:
    """Flatten to [N*N + 1]; last index is no-op. Mask illegal (src,dst) to -inf."""
    flat = edge_logits.flatten()
    mask = torch.from_numpy(valid_mask_np.flatten()).to(flat.device)
    flat = flat.masked_fill(~mask, -1e9)
    return torch.cat([flat, no_op_logit.unsqueeze(0)])


def action_to_pair(a: int, N: int) -> Optional[Tuple[int, int]]:
    if a == N * N: return None
    return (a // N, a % N)


# =========================================================================
# League: rolling pool of past checkpoints
# =========================================================================
@dataclass
class LeagueEntry:
    state_dict: dict
    iteration: int


class League:
    def __init__(self, max_size: int = 24):
        self.entries: List[LeagueEntry] = []
        self.max_size = max_size

    def add(self, state_dict: dict, iteration: int):
        self.entries.append(LeagueEntry(
            {k: v.detach().cpu().clone() for k, v in state_dict.items()},
            iteration,
        ))
        # Always keep the 3 most-recent; drop randomly from older ones.
        if len(self.entries) > self.max_size:
            drop_idx = random.randint(0, len(self.entries) - 4)
            self.entries.pop(drop_idx)

    def sample(self) -> Optional[LeagueEntry]:
        if not self.entries: return None
        return random.choice(self.entries)


# =========================================================================
# Rollout
# =========================================================================
@dataclass
class Step:
    obs: dict
    hidden: torch.Tensor
    action: int
    log_prob: float
    value: float
    reward: float
    done: bool


def policy_action(policy: GraphPolicy, obs: dict, hidden: torch.Tensor):
    nf = torch.from_numpy(obs['node_features']).to(DEVICE)
    am = torch.from_numpy(obs['adj_mat'].astype(np.float32)).to(DEVICE)
    with torch.no_grad():
        el, nop, v, new_h = policy(nf, am, hidden)
        logits = flat_logits(el, nop, obs['valid_actions'])
        probs = F.softmax(logits, dim=-1)
        a = torch.multinomial(probs, 1).item()
        log_prob = F.log_softmax(logits, dim=-1)[a].item()
    return a, log_prob, float(v.item()), new_h


def opponent_select(env: CellEnv, policy_or_none, perspective: int,
                    hidden_state: Optional[torch.Tensor]):
    """Returns (action_pair_or_None, new_hidden_state_or_None)."""
    if policy_or_none is None:
        # Heuristic fallback (matches HTML AI flavor)
        return env._heuristic_action(perspective), None
    obs = env.observe(perspective=perspective)
    if not obs['valid_actions'].any():
        return None, hidden_state
    a, _, _, new_h = policy_action(policy_or_none, obs, hidden_state)
    return action_to_pair(a, obs['n_nodes']), new_h


def run_episode(env: CellEnv, agent: GraphPolicy,
                opponent_specs: Dict[int, Optional[GraphPolicy]],
                max_steps: int = 2400) -> Tuple[List[Step], dict]:
    obs = env.reset()
    agent_hidden = agent.init_hidden()
    opp_hidden = {p: (pol.init_hidden() if pol is not None else None)
                  for p, pol in opponent_specs.items()}
    traj: List[Step] = []
    for step in range(max_steps):
        a, lp, val, agent_hidden_next = policy_action(agent, obs, agent_hidden)
        action_pair = action_to_pair(a, obs['n_nodes'])
        opp_acts = {}
        for p in range(1, N_PLAYERS):
            pol = opponent_specs.get(p)
            pair, opp_hidden[p] = opponent_select(env, pol, p, opp_hidden[p])
            opp_acts[p] = pair
        next_obs, reward, done, info = env.step(action_pair, opp_acts)
        traj.append(Step(
            obs=obs, hidden=agent_hidden.detach(),
            action=a, log_prob=lp, value=val,
            reward=reward, done=done,
        ))
        obs = next_obs
        agent_hidden = agent_hidden_next
        if done: break
    return traj, info


# =========================================================================
# PPO update
# =========================================================================
def gae(rewards, values, dones, gamma=0.99, lam=0.95, last_value=0.0):
    advs, gae_v = [], 0.0
    next_v = last_value
    for t in reversed(range(len(rewards))):
        delta = rewards[t] + gamma * next_v * (1 - dones[t]) - values[t]
        gae_v = delta + gamma * lam * (1 - dones[t]) * gae_v
        advs.insert(0, gae_v)
        next_v = values[t]
    rets = [a + v for a, v in zip(advs, values)]
    return advs, rets


def ppo_update(policy: GraphPolicy, optim: torch.optim.Optimizer,
               batch: List[Tuple], epochs: int = 4, clip: float = 0.2,
               vf_coef: float = 0.5, ent_coef: float = 0.01) -> dict:
    """Each batch entry: (obs, hidden, action, old_log_prob, advantage, return).

    Note: variable-N obs means we process one example at a time (slow but robust).
    For a real speedup, bucket by N or pad — left as future work.
    """
    actions = torch.tensor([b[2] for b in batch], dtype=torch.long, device=DEVICE)
    old_lp = torch.tensor([b[3] for b in batch], dtype=torch.float32, device=DEVICE)
    advs = torch.tensor([b[4] for b in batch], dtype=torch.float32, device=DEVICE)
    rets = torch.tensor([b[5] for b in batch], dtype=torch.float32, device=DEVICE)
    advs = (advs - advs.mean()) / (advs.std() + 1e-8)

    stats = {'pi_loss': 0.0, 'v_loss': 0.0, 'ent': 0.0}
    for _ in range(epochs):
        new_lps, values, ents = [], [], []
        for obs, hidden, *_ in batch:
            nf = torch.from_numpy(obs['node_features']).to(DEVICE)
            am = torch.from_numpy(obs['adj_mat'].astype(np.float32)).to(DEVICE)
            el, nop, v, _ = policy(nf, am, hidden.to(DEVICE))
            logits = flat_logits(el, nop, obs['valid_actions'])
            log_probs = F.log_softmax(logits, dim=-1)
            probs = log_probs.exp()
            ent = -(probs * log_probs).sum()
            new_lps.append(log_probs[actions[len(new_lps)]])
            values.append(v)
            ents.append(ent)
        new_lps = torch.stack(new_lps)
        values = torch.stack(values)
        ents = torch.stack(ents)
        ratio = (new_lps - old_lp).exp()
        s1 = ratio * advs
        s2 = torch.clamp(ratio, 1 - clip, 1 + clip) * advs
        pi_loss = -torch.min(s1, s2).mean()
        v_loss = F.mse_loss(values, rets)
        ent_mean = ents.mean()
        loss = pi_loss + vf_coef * v_loss - ent_coef * ent_mean
        optim.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(policy.parameters(), 0.5)
        optim.step()
        stats['pi_loss'] += pi_loss.item() / epochs
        stats['v_loss'] += v_loss.item() / epochs
        stats['ent'] += ent_mean.item() / epochs
    return stats


# =========================================================================
# Opponent sampler: 60% latest / 25% pool / 15% heuristic
# =========================================================================
def sample_opponents(latest_policy: GraphPolicy, league: League,
                     in_dim: int) -> Dict[int, Optional[GraphPolicy]]:
    opps: Dict[int, Optional[GraphPolicy]] = {}
    for p in range(1, N_PLAYERS):
        r = random.random()
        if r < 0.60:
            opps[p] = latest_policy                           # mirror match
        elif r < 0.85 and len(league.entries) > 1:
            entry = league.sample()
            pol = GraphPolicy(in_dim).to(DEVICE)
            pol.load_state_dict({k: v.to(DEVICE) for k, v in entry.state_dict.items()})
            pol.eval()
            opps[p] = pol
        else:
            opps[p] = None                                     # heuristic baseline
    return opps


# =========================================================================
# Main training loop
# =========================================================================
def train(iterations: int = 500,
          episodes_per_iter: int = 6,
          save_every: int = 20,
          ckpt_dir: str = './league'):
    os.makedirs(ckpt_dir, exist_ok=True)

    # Probe env to get feature dim
    env = CellEnv(seed=0)
    obs = env.reset()
    in_dim = obs['node_features'].shape[1]
    print(f"Per-node feature dim: {in_dim}")

    policy = GraphPolicy(in_dim).to(DEVICE)
    optim = torch.optim.Adam(policy.parameters(), lr=3e-4)
    league = League()
    league.add(policy.state_dict(), 0)

    win_log = deque(maxlen=50)
    t0 = time.time()

    for it in range(1, iterations + 1):
        all_steps: List[Tuple] = []
        wins = 0

        for ep in range(episodes_per_iter):
            opp_specs = sample_opponents(policy, league, in_dim)
            traj, info = run_episode(env, policy, opp_specs)
            advs, rets = gae(
                [s.reward for s in traj],
                [s.value for s in traj],
                [s.done for s in traj],
            )
            for i, s in enumerate(traj):
                all_steps.append((s.obs, s.hidden, s.action, s.log_prob, advs[i], rets[i]))
            # Win = our slot is the last non-neutral standing AND positive terminal
            if traj[-1].done and traj[-1].reward > 0.5:
                wins += 1

        win_log.append(wins / episodes_per_iter)
        random.shuffle(all_steps)
        stats = ppo_update(policy, optim, all_steps)

        if it % save_every == 0 or it == 1:
            league.add(policy.state_dict(), it)
            ckpt_path = os.path.join(ckpt_dir, f'ckpt_{it:06d}.pt')
            torch.save(policy.state_dict(), ckpt_path)
            elapsed = time.time() - t0
            avg_win = float(np.mean(win_log)) if win_log else 0.0
            print(f"[iter {it:5d}] wall {elapsed:7.0f}s | win {avg_win:.2%} | "
                  f"league {len(league.entries):2d} | pi {stats['pi_loss']:+.3f} "
                  f"v {stats['v_loss']:.3f} ent {stats['ent']:.3f} | "
                  f"saved {ckpt_path}")

    torch.save(policy.state_dict(), os.path.join(ckpt_dir, 'final.pt'))
    print(f"Done. Final policy at {ckpt_dir}/final.pt")


# =========================================================================
if __name__ == '__main__':
    # Tunable: scale up iterations & episodes for real Kaggle runs.
    # Defaults give a quick smoke test on CPU/GPU.
    train(
        iterations=300,
        episodes_per_iter=4,
        save_every=10,
    )
