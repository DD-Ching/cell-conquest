"""
export_onnx.py — convert trained final.pt to ONNX for in-browser inference.

Run:
    pip install torch onnx
    python /Users/ddh/Cell/export_onnx.py /Users/ddh/Downloads/muh/final.pt /Users/ddh/Cell/cell_policy.onnx
"""
import sys
import os
import torch
import torch.nn as nn
import torch.nn.functional as F

HIDDEN  = 96
GRU_DIM = 96
N_FIXED = 40
F_DIM   = 21


class GraphConv(nn.Module):
    def __init__(self, dim):
        super().__init__()
        self.self_lin = nn.Linear(dim, dim)
        self.nbr_lin  = nn.Linear(dim, dim)
    def forward(self, h, adj_norm):
        return F.gelu(self.self_lin(h) + self.nbr_lin(adj_norm @ h))


class GraphPolicy(nn.Module):
    def __init__(self, in_dim=F_DIM, hidden=HIDDEN, gru_dim=GRU_DIM):
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


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else '/Users/ddh/Downloads/muh/final.pt'
    dst = sys.argv[2] if len(sys.argv) > 2 else '/Users/ddh/Cell/cell_policy.onnx'

    print(f"Loading {src}...")
    sd = torch.load(src, map_location='cpu', weights_only=True)
    if any(k.startswith('_orig_mod.') for k in sd):
        sd = {k.replace('_orig_mod.', ''): v for k, v in sd.items()}

    policy = GraphPolicy()
    policy.load_state_dict(sd)
    policy.eval()
    print(f"Params: {sum(x.numel() for x in policy.parameters()):,}")

    nf  = torch.zeros(1, N_FIXED, F_DIM)
    am  = torch.zeros(1, N_FIXED, N_FIXED)
    hid = torch.zeros(1, GRU_DIM)
    with torch.no_grad():
        out = policy(nf, am, hid)
    print(f"Forward OK. edge_logits {tuple(out[0].shape)}, no_op {tuple(out[1].shape)}, "
          f"value {tuple(out[2].shape)}, hidden {tuple(out[3].shape)}")

    print(f"Exporting → {dst}")
    torch.onnx.export(
        policy,
        (nf, am, hid),
        dst,
        input_names=['nf', 'am', 'hidden_in'],
        output_names=['edge_logits', 'no_op_logit', 'value', 'hidden_out'],
        opset_version=17,
        dynamic_axes={
            'nf':         {0: 'batch'},
            'am':         {0: 'batch'},
            'hidden_in':  {0: 'batch'},
            'edge_logits':{0: 'batch'},
            'no_op_logit':{0: 'batch'},
            'value':      {0: 'batch'},
            'hidden_out': {0: 'batch'},
        },
    )
    print(f"Done. {os.path.getsize(dst) / 1024:.1f} KB")


if __name__ == '__main__':
    main()
