import torch
import torch.nn as nn
import numpy as np

SMPL_X_JOINTS = [
    "pelvis", "left_hip", "right_hip", "spine1", "left_knee", "right_knee", "spine2",
    "left_ankle", "right_ankle", "spine3", "left_foot", "right_foot", "neck",
    "left_collar", "right_collar", "head", "left_shoulder", "right_shoulder",
    "left_elbow", "right_elbow", "left_wrist", "right_wrist",
    "left_index1", "left_index2", "left_index3",
    "left_middle1", "left_middle2", "left_middle3",
    "left_pinky1", "left_pinky2", "left_pinky3",
    "left_ring1", "left_ring2", "left_ring3",
    "left_thumb1", "left_thumb2", "left_thumb3",
    "right_index1", "right_index2", "right_index3",
    "right_middle1", "right_middle2", "right_middle3",
    "right_pinky1", "right_pinky2", "right_pinky3",
    "right_ring1", "right_ring2", "right_ring3",
    "right_thumb1", "right_thumb2", "right_thumb3"
]

SMPLX_TO_VRM = {
    "pelvis": "hips",
    "spine1": "spine",
    "spine2": "chest",
    "spine3": "upperChest",
    "neck": "neck",
    "head": "head",
    "left_collar": "leftShoulder",
    "right_collar": "rightShoulder",
    "left_shoulder": "leftUpperArm",
    "right_shoulder": "rightUpperArm",
    "left_elbow": "leftLowerArm",
    "right_elbow": "rightLowerArm",
    "left_wrist": "leftHand",
    "right_wrist": "rightHand",
    "left_hip": "leftUpperLeg",
    "right_hip": "rightUpperLeg",
    "left_knee": "leftLowerLeg",
    "right_knee": "rightLowerLeg",
    "left_ankle": "leftFoot",
    "right_ankle": "rightFoot",
    "left_foot": "leftToes",
    "right_foot": "rightToes",
    "left_thumb1": "leftThumbProximal",
    "left_thumb2": "leftThumbIntermediate",
    "left_thumb3": "leftThumbDistal",
    "left_index1": "leftIndexProximal",
    "left_index2": "leftIndexIntermediate",
    "left_index3": "leftIndexDistal",
    "left_middle1": "leftMiddleProximal",
    "left_middle2": "leftMiddleIntermediate",
    "left_middle3": "leftMiddleDistal",
    "left_ring1": "leftRingProximal",
    "left_ring2": "leftRingIntermediate",
    "left_ring3": "leftRingDistal",
    "left_pinky1": "leftLittleProximal",
    "left_pinky2": "leftLittleIntermediate",
    "left_pinky3": "leftLittleDistal",
    "right_thumb1": "rightThumbProximal",
    "right_thumb2": "rightThumbIntermediate",
    "right_thumb3": "rightThumbDistal",
    "right_index1": "rightIndexProximal",
    "right_index2": "rightIndexIntermediate",
    "right_index3": "rightIndexDistal",
    "right_middle1": "rightMiddleProximal",
    "right_middle2": "rightMiddleIntermediate",
    "right_middle3": "rightMiddleDistal",
    "right_ring1": "rightRingProximal",
    "right_ring2": "rightRingIntermediate",
    "right_ring3": "rightRingDistal",
    "right_pinky1": "rightLittleProximal",
    "right_pinky2": "rightLittleIntermediate",
    "right_pinky3": "rightLittleDistal"
}

class PositionalEncoding(nn.Module):
    def __init__(self, d_model, max_len=5000):
        super().__init__()
        pe = torch.zeros(max_len, d_model)
        position = torch.arange(0, max_len, dtype=torch.float).unsqueeze(1)
        div_term = torch.exp(torch.arange(0, d_model, 2).float() * (-np.log(10000.0) / d_model))
        pe[:, 0::2] = torch.sin(position * div_term)
        pe[:, 1::2] = torch.cos(position * div_term)
        self.register_buffer('pe', pe.unsqueeze(0))

    def forward(self, x):
        return x + self.pe[:, :x.size(1)]

class EMAGEMotionDecoderFP16(nn.Module):
    def __init__(self, audio_dim=1024, text_dim=768, hidden_dim=512, num_layers=6, nhead=8, num_joints=52):
        super().__init__()
        self.num_joints = num_joints
        self.audio_proj = nn.Linear(audio_dim, hidden_dim)
        self.text_proj = nn.Linear(text_dim, hidden_dim)
        
        self.pos_encoder = PositionalEncoding(hidden_dim)
        encoder_layer = nn.TransformerEncoderLayer(d_model=hidden_dim, nhead=nhead, dim_feedforward=hidden_dim*4, batch_first=True, activation='gelu')
        self.transformer = nn.TransformerEncoder(encoder_layer, num_layers=num_layers)
        
        self.body_head = nn.Sequential(
            nn.Linear(hidden_dim, hidden_dim),
            nn.GELU(),
            nn.Linear(hidden_dim, num_joints * 6)
        )
        self.face_head = nn.Sequential(
            nn.Linear(hidden_dim, 256),
            nn.GELU(),
            nn.Linear(256, 50)
        )
        
    def forward(self, audio_feat, text_feat=None):
        B, T, _ = audio_feat.shape
        x_audio = self.audio_proj(audio_feat)
        
        if text_feat is not None:
            x_text = self.text_proj(text_feat).unsqueeze(1)
            x = x_audio + x_text
        else:
            x = x_audio
            
        x = self.pos_encoder(x)
        feat = self.transformer(x)
        
        rot6d = self.body_head(feat).view(B, T, self.num_joints, 6)
        face_weights = torch.sigmoid(self.face_head(feat))
        
        x_raw = rot6d[..., 0:3]
        y_raw = rot6d[..., 3:6]
        x = nn.functional.normalize(x_raw, dim=-1)
        z = nn.functional.normalize(torch.cross(x, y_raw, dim=-1), dim=-1)
        y = torch.cross(z, x, dim=-1)
        rot_mat = torch.stack([x, y, z], dim=-1)
        
        quats = self.rotmat_to_quat(rot_mat)
        return quats, face_weights

    @staticmethod
    def rotmat_to_quat(R):
        m00, m01, m02 = R[..., 0, 0], R[..., 0, 1], R[..., 0, 2]
        m10, m11, m12 = R[..., 1, 0], R[..., 1, 1], R[..., 1, 2]
        m20, m21, m22 = R[..., 2, 0], R[..., 2, 1], R[..., 2, 2]
        tr = m00 + m11 + m22
        
        qw = torch.sqrt(torch.clamp(1.0 + tr, min=1e-8)) * 0.5
        qx = (m21 - m12) / (4.0 * torch.clamp(qw, min=1e-4))
        qy = (m02 - m20) / (4.0 * torch.clamp(qw, min=1e-4))
        qz = (m10 - m01) / (4.0 * torch.clamp(qw, min=1e-4))
        
        q = torch.stack([qx, qy, qz, qw], dim=-1)
        return nn.functional.normalize(q, dim=-1)
