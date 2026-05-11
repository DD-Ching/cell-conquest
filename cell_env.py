"""
Cell Conquest — variable-player headless RL env (v2).

Key design changes from v1:
  - N_MAX_PLAYERS = 8 (architecture max). Each episode samples n_active ∈ [2, 6]
    by default. Same model can play 1v1, 1v3, 1v7, FFA — any configuration.
  - Player-agnostic observation: per-node features encode {is_mine, is_neutral,
    is_enemy} + the owner's share of board, NOT specific player identity.
    Plus 3 global hints broadcast to every node.
  - Total per-node feature dim: 23.

Rules unchanged from v1:
  - Random nodes, k-NN road graph, ensured connected.
  - Hub nodes (high degree) bonus to size / capacity / regen.
  - Owned nodes regen at size / 30 units/sec, capped at capacity.
  - Same-owner arrivals stack to capacity * 1.5.
  - Path must traverse own territory only (final dst can be any owner).
  - Capture target if arriving units > defenders.
  - Heuristic aggression rises with game time → no infinite stalemate.

Action: discrete (src, dst), dst must be in adj[src]. None = no-op.
Pure NumPy, no torch dependency.
"""
from __future__ import annotations
import heapq
from dataclasses import dataclass
from typing import List, Optional, Tuple, Dict
import numpy as np

# ---------- Constants ----------
WORLD_W = 2800.0
WORLD_H = 2000.0
N_MAX_PLAYERS = 8                # architecture max — supports up to 8 players
NEUTRAL = N_MAX_PLAYERS          # owner id for unowned nodes
FLEET_SPEED = 95.0
CAP_OVERFLOW = 1.5
ROAD_MAX_DIST = 340.0
ROAD_K = 3
NODE_MIN_GAP = 95.0
NODE_MARGIN = 130.0
DEFAULT_NODES = 40
DEFAULT_STEP_SECONDS = 0.25
PER_NODE_FEATURES = 23           # see observe()

# Default player-count sampling distribution (weighted)
PLAYER_COUNT_WEIGHTS = {2: 1, 3: 2, 4: 4, 5: 2, 6: 1}


def _pick_size(rng):
    r = rng.random()
    if r < 0.32: return 20.0 + rng.random() * 5.0
    if r < 0.58: return 26.0 + rng.random() * 6.0
    if r < 0.77: return 33.0 + rng.random() * 7.0
    if r < 0.92: return 44.0 + rng.random() * 8.0
    return 56.0 + rng.random() * 12.0


@dataclass
class Fleet:
    owner: int
    units: float
    path: List[int]
    seg_idx: int = 0
    seg_traveled: float = 0.0


class CellEnv:
    def __init__(self,
                 n_nodes: int = DEFAULT_NODES,
                 max_game_seconds: float = 600.0,
                 step_seconds: float = DEFAULT_STEP_SECONDS,
                 min_players: int = 2,
                 max_players: int = 6,
                 fixed_players: Optional[int] = None,
                 seed: Optional[int] = None):
        self.n_nodes_target = n_nodes
        self.max_game_seconds = max_game_seconds
        self.step_seconds = step_seconds
        self.min_players = max(2, min_players)
        self.max_players = min(max_players, N_MAX_PLAYERS)
        self.fixed_players = fixed_players
        self.rng = np.random.default_rng(seed)
        self.reset()

    # ============================================================
    # Setup
    # ============================================================
    def reset(self, seed: Optional[int] = None) -> Dict:
        if seed is not None:
            self.rng = np.random.default_rng(seed)
        # Sample number of active players for this episode
        if self.fixed_players is not None:
            self.n_active = int(self.fixed_players)
        else:
            valid = {k: v for k, v in PLAYER_COUNT_WEIGHTS.items()
                     if self.min_players <= k <= self.max_players}
            if not valid:
                self.n_active = self.min_players
            else:
                choices = list(valid.keys())
                weights = np.array([valid[k] for k in choices], dtype=np.float32)
                self.n_active = int(self.rng.choice(choices, p=weights / weights.sum()))

        self._place_nodes()
        self._build_roads()
        self._adjust_hub_sizes()
        self._assign_starts()
        self.fleets: List[Fleet] = []
        self.t = 0.0
        self.steps = 0
        self._prev_share = self._my_share(0)
        return self.observe(perspective=0)

    def _place_nodes(self):
        xs, ys, sizes = [], [], []
        attempts = 0
        while len(xs) < self.n_nodes_target and attempts < 14000:
            attempts += 1
            size = _pick_size(self.rng)
            x = NODE_MARGIN + self.rng.random() * (WORLD_W - NODE_MARGIN * 2)
            y = NODE_MARGIN + self.rng.random() * (WORLD_H - NODE_MARGIN * 2)
            ok = True
            for px, py, ps in zip(xs, ys, sizes):
                req = NODE_MIN_GAP + size + ps
                if (x - px) ** 2 + (y - py) ** 2 < req * req:
                    ok = False; break
            if ok:
                xs.append(x); ys.append(y); sizes.append(size)
        N = len(xs)
        self.N = N
        self.nodes_x = np.array(xs, dtype=np.float32)
        self.nodes_y = np.array(ys, dtype=np.float32)
        self.nodes_size = np.array(sizes, dtype=np.float32)
        self.nodes_capacity = np.floor(self.nodes_size * 3.6).astype(np.float32)
        self.nodes_regen = self.nodes_size / 30.0
        self.nodes_owner = np.full(N, NEUTRAL, dtype=np.int32)
        self.nodes_units = np.floor(
            self.nodes_size * 0.85 + self.rng.random(N) * self.nodes_size * 0.55
        ).astype(np.float32)

    def _build_roads(self):
        N = self.N
        dx = self.nodes_x[:, None] - self.nodes_x[None, :]
        dy = self.nodes_y[:, None] - self.nodes_y[None, :]
        dmat = np.sqrt(dx * dx + dy * dy).astype(np.float32)
        np.fill_diagonal(dmat, np.inf)
        self.dist_mat = dmat

        adj: List[set] = [set() for _ in range(N)]
        for i in range(N):
            order = np.argsort(dmat[i])
            count = 0
            for j in order:
                if j == i: continue
                if dmat[i, j] > ROAD_MAX_DIST: break
                if count >= ROAD_K: break
                adj[i].add(int(j)); adj[int(j)].add(i)
                count += 1

        # Ensure connectivity
        parent = list(range(N))
        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]; x = parent[x]
            return x
        for i in range(N):
            for j in adj[i]:
                if j > i:
                    ri, rj = find(i), find(j)
                    if ri != rj: parent[ri] = rj
        for _ in range(60):
            comps: Dict[int, list] = {}
            for i in range(N):
                comps.setdefault(find(i), []).append(i)
            if len(comps) <= 1: break
            best = (np.inf, -1, -1)
            keys = list(comps.keys())
            for ki in range(len(keys)):
                for kj in range(ki + 1, len(keys)):
                    for a in comps[keys[ki]]:
                        for b in comps[keys[kj]]:
                            d = float(dmat[a, b])
                            if d < best[0]: best = (d, a, b)
            if best[1] < 0: break
            adj[best[1]].add(best[2]); adj[best[2]].add(best[1])
            parent[find(best[1])] = find(best[2])

        self.adj = adj
        self.adj_mat = np.zeros((N, N), dtype=bool)
        for i in range(N):
            for j in adj[i]: self.adj_mat[i, j] = True

    def _adjust_hub_sizes(self):
        for i in range(self.N):
            deg = len(self.adj[i])
            bonus = max(0.0, deg - 3) * 4.0
            if bonus <= 0: continue
            max_allowed = float('inf')
            for j in range(self.N):
                if i == j: continue
                allowed = float(self.dist_mat[i, j]) - 60.0 - float(self.nodes_size[j])
                if allowed < max_allowed: max_allowed = allowed
            new_size = min(float(self.nodes_size[i]) + bonus, max_allowed, 75.0)
            if new_size > self.nodes_size[i]:
                self.nodes_size[i] = new_size
                self.nodes_capacity[i] = float(np.floor(new_size * 3.6))
                self.nodes_regen[i] = new_size / 30.0

    def _assign_starts(self):
        placed: List[int] = []
        for p in range(self.n_active):
            best_i, best_d = -1, -1.0
            for i in range(self.N):
                if self.nodes_owner[i] != NEUTRAL: continue
                if not placed:
                    d = (self.nodes_x[i] - WORLD_W / 2) ** 2 + (self.nodes_y[i] - WORLD_H / 2) ** 2
                else:
                    d = min(
                        (self.nodes_x[i] - self.nodes_x[k]) ** 2 +
                        (self.nodes_y[i] - self.nodes_y[k]) ** 2
                        for k in placed
                    )
                if d > best_d: best_d, best_i = d, i
            if best_i >= 0:
                self.nodes_owner[best_i] = p
                self.nodes_units[best_i] = 48.0
                self.nodes_size[best_i] = 38.0
                self.nodes_capacity[best_i] = 145.0
                self.nodes_regen[best_i] = 1.5
                placed.append(best_i)

    # ============================================================
    # Mechanics
    # ============================================================
    def _fleet_eta(self, f: Fleet) -> float:
        remaining = 0.0
        if f.seg_idx < len(f.path) - 1:
            a, b = f.path[f.seg_idx], f.path[f.seg_idx + 1]
            seg_len = float(self.dist_mat[a, b])
            remaining += max(0.0, seg_len - f.seg_traveled)
            for k in range(f.seg_idx + 1, len(f.path) - 1):
                remaining += float(self.dist_mat[f.path[k], f.path[k + 1]])
        return remaining / FLEET_SPEED

    def find_path(self, src: int, dst: int, traveler: int) -> Optional[List[int]]:
        if src == dst: return [src]
        N = self.N
        dist = np.full(N, np.inf, dtype=np.float32)
        prev = [-1] * N
        dist[src] = 0.0
        seen = [False] * N
        heap: list = [(0.0, src)]
        while heap:
            d, u = heapq.heappop(heap)
            if seen[u]: continue
            seen[u] = True
            if u == dst: break
            for v in self.adj[u]:
                if v != dst and self.nodes_owner[v] != traveler: continue
                nd = d + float(self.dist_mat[u, v])
                if nd < dist[v]:
                    dist[v] = nd; prev[v] = u
                    heapq.heappush(heap, (nd, v))
        if prev[dst] == -1 and src != dst: return None
        path = [dst]; cur = dst
        while prev[cur] != -1:
            cur = prev[cur]; path.insert(0, cur)
        return path

    def send_fleet(self, src: int, dst: int, amount: float) -> bool:
        amount = int(amount)
        if amount < 1: return False
        amount = min(amount, int(self.nodes_units[src]))
        if amount < 1: return False
        path = self.find_path(src, dst, int(self.nodes_owner[src]))
        if path is None or len(path) < 2: return False
        self.nodes_units[src] -= amount
        self.fleets.append(Fleet(
            owner=int(self.nodes_owner[src]),
            units=float(amount),
            path=path,
        ))
        return True

    def _advance(self, dt: float):
        owned = self.nodes_owner != NEUTRAL
        self.nodes_units[owned] = np.minimum(
            self.nodes_capacity[owned],
            self.nodes_units[owned] + self.nodes_regen[owned] * dt,
        )
        keep: List[Fleet] = []
        for f in self.fleets:
            f.seg_traveled += FLEET_SPEED * dt
            while f.seg_idx < len(f.path) - 1:
                a, b = f.path[f.seg_idx], f.path[f.seg_idx + 1]
                seg_len = float(self.dist_mat[a, b])
                if f.seg_traveled < seg_len: break
                f.seg_traveled -= seg_len
                f.seg_idx += 1
            if f.seg_idx >= len(f.path) - 1:
                self._arrive(f.owner, int(f.units), f.path[-1])
            else:
                keep.append(f)
        self.fleets = keep
        self.t += dt

    def _arrive(self, owner: int, units: int, tgt: int):
        if self.nodes_owner[tgt] == owner:
            self.nodes_units[tgt] = min(
                self.nodes_capacity[tgt] * CAP_OVERFLOW,
                self.nodes_units[tgt] + units,
            )
        else:
            if units > self.nodes_units[tgt]:
                self.nodes_units[tgt] = units - self.nodes_units[tgt]
                self.nodes_owner[tgt] = owner
            else:
                self.nodes_units[tgt] -= units

    # ============================================================
    # Step API
    # ============================================================
    def step(self,
             action: Optional[Tuple[int, int]] = None,
             opponent_actions: Optional[Dict[int, Tuple[int, int]]] = None
             ) -> Tuple[Dict, float, bool, Dict]:
        if action is not None:
            src, dst = action
            self.send_fleet(src, dst, self.nodes_units[src] * 0.5)
        # Only iterate active opponents (slots 1..n_active-1)
        for p in range(1, self.n_active):
            opp = (opponent_actions or {}).get(p)
            if opp is None:
                opp = self._heuristic_action(p)
            if opp is not None:
                src, dst = opp
                self.send_fleet(src, dst, self.nodes_units[src] * 0.5)

        self._advance(self.step_seconds)
        self.steps += 1

        # Done: only count owners among active player ids
        owners = set(int(o) for o in self.nodes_owner if 0 <= o < self.n_active)
        for f in self.fleets:
            if 0 <= f.owner < self.n_active:
                owners.add(f.owner)
        done = (0 not in owners) or (len(owners) <= 1) or (self.t >= self.max_game_seconds)

        share = self._my_share(0)
        reward = (share - self._prev_share) * 2.0
        self._prev_share = share
        is_leader = False
        if done:
            if 0 in owners and len(owners) == 1:
                reward += 1.0
                is_leader = True
            elif 0 not in owners:
                reward -= 1.0
            else:
                counts = [int((self.nodes_owner == p).sum()) for p in range(self.n_active)]
                my_n = counts[0]; top = max(counts)
                if my_n >= top and my_n > 0:
                    reward += 0.5
                    is_leader = True
                elif my_n > 0:
                    reward -= 0.3 * (1.0 - my_n / max(1, top))
                else:
                    reward -= 0.5

        info = {
            'n_mine': int((self.nodes_owner == 0).sum()),
            'n_total_owned': int((self.nodes_owner != NEUTRAL).sum()),
            't': self.t,
            'share': share,
            'is_leader': is_leader,
            'n_active': self.n_active,
        }
        return self.observe(perspective=0), float(reward), done, info

    def _my_share(self, owner: int) -> float:
        owned = (self.nodes_owner != NEUTRAL).sum()
        if owned == 0: return 0.0
        return float((self.nodes_owner == owner).sum()) / float(owned)

    # ============================================================
    # Heuristic baseline (same as v1 — strong + time-aggressive)
    # ============================================================
    def _heuristic_action(self, owner: int) -> Optional[Tuple[int, int]]:
        my = np.where(self.nodes_owner == owner)[0]
        if len(my) == 0: return None
        aggression = 1.0 + min(self.t / 180.0, 2.0)
        best, best_score = None, 0.0
        for src in my:
            if self.nodes_units[src] < 12: continue
            enemy_neighbors = sum(
                1 for j in self.adj[int(src)]
                if self.nodes_owner[j] != owner and self.nodes_owner[j] != NEUTRAL
            )
            reserve = self.nodes_units[src] * (0.15 + enemy_neighbors * 0.18) + 5 + enemy_neighbors * 9
            avail = float(self.nodes_units[src]) - reserve
            if avail < 5: continue
            for dst in self.adj[int(src)]:
                if self.nodes_owner[dst] == owner: continue
                d = float(self.dist_mat[src, dst])
                arrival = d / FLEET_SPEED
                defenders = float(self.nodes_units[dst])
                if self.nodes_owner[dst] != NEUTRAL:
                    defenders += float(self.nodes_regen[dst]) * arrival
                for f in self.fleets:
                    if f.path[-1] != dst: continue
                    if f.owner == int(self.nodes_owner[dst]): defenders += f.units
                    elif f.owner == owner: defenders -= f.units
                defenders = max(0.0, defenders)
                required = defenders + 5 + float(self.nodes_size[dst]) * 0.3
                min_threshold = required / aggression
                if avail < min_threshold: continue
                value = len(self.adj[dst]) * 1.6 + float(self.nodes_regen[dst]) * 6 + float(self.nodes_size[dst]) * 0.6
                score = value / (required + 8)
                if self.nodes_owner[dst] == NEUTRAL: score *= 1.5
                score *= aggression
                if score > best_score:
                    best_score, best = score, (int(src), int(dst))
        return best

    # ============================================================
    # Observation — PLAYER-AGNOSTIC (23 features per node)
    # ============================================================
    def observe(self, perspective: int = 0) -> Dict:
        N = self.N
        me = perspective
        owners = self.nodes_owner

        # Ownership (3): mutually exclusive
        is_mine = (owners == me).astype(np.float32)
        is_neutral = (owners == NEUTRAL).astype(np.float32)
        is_enemy = 1.0 - is_mine - is_neutral

        # Owner share (1): this owner's fraction of board (0 for neutral)
        owned_mask = owners != NEUTRAL
        n_owned = max(1, int(owned_mask.sum()))
        owner_share = np.zeros(N, dtype=np.float32)
        for p in range(self.n_active):
            count = int((owners == p).sum())
            if count > 0:
                owner_share[owners == p] = count / n_owned

        # Cap awareness (3)
        cap_safe = np.maximum(1.0, self.nodes_capacity)
        sat = self.nodes_units / cap_safe
        cap_room = np.clip(1.0 - sat, 0.0, 1.0)
        at_full = (sat > 0.95).astype(np.float32)

        # Absolute / scale (4)
        units_abs = self.nodes_units / 100.0
        cap_norm = self.nodes_capacity / 100.0
        regen_norm = self.nodes_regen / 2.0
        size_norm = self.nodes_size / 60.0

        # Neighbor counts (3) — vectorized via adj @ indicator
        am_f = self.adj_mat.astype(np.float32)
        n_friend = am_f @ is_mine
        n_neut = am_f @ is_neutral
        n_enemy = am_f @ is_enemy

        # Incoming (6)
        inc_friend = np.zeros(N, dtype=np.float32)
        inc_hostile = np.zeros(N, dtype=np.float32)
        inc_friend_eta = np.full(N, 30.0, dtype=np.float32)
        inc_hostile_eta = np.full(N, 30.0, dtype=np.float32)
        inc_friend_imm = np.zeros(N, dtype=np.float32)
        inc_hostile_imm = np.zeros(N, dtype=np.float32)
        for f in self.fleets:
            tgt = f.path[-1]
            eta = self._fleet_eta(f)
            if f.owner == me:
                inc_friend[tgt] += f.units
                if eta < inc_friend_eta[tgt]: inc_friend_eta[tgt] = eta
                if eta <= 5.0: inc_friend_imm[tgt] += f.units
            else:
                inc_hostile[tgt] += f.units
                if eta < inc_hostile_eta[tgt]: inc_hostile_eta[tgt] = eta
                if eta <= 5.0: inc_hostile_imm[tgt] += f.units

        # Global broadcast (3): my share, top enemy share, num active / max
        my_share = float((owners == me).sum()) / float(n_owned) if n_owned > 0 else 0.0
        top_enemy = 0.0
        for p in range(self.n_active):
            if p == me: continue
            c = int((owners == p).sum())
            if c > 0:
                top_enemy = max(top_enemy, c / n_owned)
        n_active_norm = self.n_active / float(N_MAX_PLAYERS)

        my_share_b = np.full(N, my_share, dtype=np.float32)
        top_enemy_b = np.full(N, top_enemy, dtype=np.float32)
        n_active_b = np.full(N, n_active_norm, dtype=np.float32)

        feats = np.concatenate([
            is_mine[:, None], is_neutral[:, None], is_enemy[:, None],     # 3 ownership
            owner_share[:, None],                                          # 1
            sat[:, None], cap_room[:, None], at_full[:, None],             # 3 cap
            units_abs[:, None], cap_norm[:, None],
            regen_norm[:, None], size_norm[:, None],                       # 4 scale
            (n_friend / 8.0)[:, None],
            (n_enemy / 8.0)[:, None],
            (n_neut / 8.0)[:, None],                                       # 3 neighbors
            (inc_friend / 100.0)[:, None],
            (inc_hostile / 100.0)[:, None],
            (inc_friend_eta / 30.0)[:, None],
            (inc_hostile_eta / 30.0)[:, None],
            (inc_friend_imm / 100.0)[:, None],
            (inc_hostile_imm / 100.0)[:, None],                            # 6 incoming
            my_share_b[:, None],
            top_enemy_b[:, None],
            n_active_b[:, None],                                            # 3 global
        ], axis=1).astype(np.float32)
        # Total: 3+1+3+4+3+6+3 = 23 ✓

        edge_src, edge_dst = [], []
        for i in range(N):
            for j in self.adj[i]:
                edge_src.append(i); edge_dst.append(j)
        edge_index = np.array([edge_src, edge_dst], dtype=np.int64)

        valid = np.zeros((N, N), dtype=bool)
        my_mask = (owners == me) & (self.nodes_units >= 2)
        for src in np.where(my_mask)[0]:
            for dst in self.adj[int(src)]:
                valid[src, dst] = True

        return {
            'node_features': feats,
            'edge_index': edge_index,
            'adj_mat': self.adj_mat,
            'valid_actions': valid,
            'n_nodes': N,
            'n_active_players': self.n_active,
            't_frac': float(self.t / self.max_game_seconds),
        }


# =================================================================
# Smoke test
# =================================================================
if __name__ == '__main__':
    import time
    print("=== cell_env.py v2 smoke test ===")
    for npl in [2, 4, 6]:
        env = CellEnv(seed=42, fixed_players=npl)
        obs = env.reset()
        assert obs['node_features'].shape[1] == PER_NODE_FEATURES, \
            f"Feature dim mismatch: {obs['node_features'].shape[1]} vs {PER_NODE_FEATURES}"
        print(f"  n_active={npl}: N={env.N}, F={obs['node_features'].shape[1]}, "
              f"edges={obs['edge_index'].shape[1] // 2}")
        # Run a short episode
        rng = np.random.default_rng(0)
        for step in range(200):
            v = obs['valid_actions']
            srcs, dsts = np.where(v)
            if len(srcs) and rng.random() < 0.5:
                i = rng.integers(len(srcs))
                action = (int(srcs[i]), int(dsts[i]))
            else:
                action = None
            obs, r, done, info = env.step(action)
            if done: break
        print(f"    finished step {step+1}, t={info['t']:.1f}s, "
              f"share={info['share']:.2f}, leader={info['is_leader']}")

    # Throughput test
    env = CellEnv(seed=1)
    obs = env.reset()
    rng = np.random.default_rng(0)
    t0 = time.time()
    n_steps = 0
    for ep in range(20):
        obs = env.reset()
        for step in range(2400):
            v = obs['valid_actions']
            srcs, dsts = np.where(v)
            if len(srcs) and rng.random() < 0.5:
                i = rng.integers(len(srcs))
                action = (int(srcs[i]), int(dsts[i]))
            else:
                action = None
            obs, r, done, info = env.step(action)
            n_steps += 1
            if done: break
    dt = time.time() - t0
    print(f"\nThroughput: {n_steps/dt:.0f} steps/sec ({n_steps} steps in {dt:.2f}s)")
    print("=== smoke test PASSED ===")
