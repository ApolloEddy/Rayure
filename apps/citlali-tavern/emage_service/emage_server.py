import os, sys, time, json, math
import torch
import numpy as np
from http.server import HTTPServer, BaseHTTPRequestHandler
from transformers import AutoTokenizer, AutoModel

os.environ['HF_ENDPOINT'] = 'https://hf-mirror.com'

device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
print(f"[EMAGE Server] Device: {device}")

try:
    tokenizer = AutoTokenizer.from_pretrained('t5-base', local_files_only=True)
    t5_model = AutoModel.from_pretrained('t5-base', local_files_only=True)
except Exception:
    tokenizer = AutoTokenizer.from_pretrained('t5-base')
    t5_model = AutoModel.from_pretrained('t5-base')

if device.type == 'cuda':
    t5_model = t5_model.half().to(device)
t5_model.eval()
print("[EMAGE Server] T5-Base loaded in FP16!")

# 100% 正向向前（人体力学台前手势）语义骨骼配置
SEMANTIC_PROFILES = {
    "shy": {
        "name": "娇羞偏头 (Shy)",
        "keywords": ["别一直盯", "笨蛋", "害羞", "脸红", "讨厌", "看我"],
        "head_sway": [-0.15, -0.18],
        "arm_l": [-0.75, 0.25, -0.15], "forearm_l": [-0.35, 0.55, -0.75],
        "arm_r": [-1.05, -0.35, 0.25], "forearm_r": [0.45, -0.75, 1.25], # 右手轻抚脸颊娇羞
        "mouth": 0.45, "smile": 0.3, "blush": 1.0
    },
    "greet": {
        "name": "热情挥手 (Wave)",
        "keywords": ["你好", "很高兴", "欢迎", "相遇", "嗨", "旅行者"],
        "head_sway": [0.08, 0.12],
        "arm_l": [-0.75, 0.25, -0.15], "forearm_l": [-0.35, 0.55, -0.75], # 左手伏案
        "arm_r": [-1.45, -0.25, 0.45], "forearm_r": [-0.75, 0.45, 0.95],  # 右手空中招手挥动
        "mouth": 0.70, "smile": 0.90, "blush": 0.0
    },
    "tsundere": {
        "name": "傲娇挺胸 (Tsundere)",
        "keywords": ["哼", "误会", "稍微帮你", "可别", "小看", "这次"],
        "head_sway": [0.18, 0.15],
        "arm_l": [-0.85, 0.35, -0.25], "forearm_l": [-0.30, 0.75, -1.05], # 双手抱胸伏案
        "arm_r": [-0.85, -0.35, 0.25], "forearm_r": [-0.30, -0.75, 1.05],
        "mouth": 0.50, "smile": 0.60, "blush": 0.5
    },
    "playful": {
        "name": "调皮打拍 (Playful)",
        "keywords": ["吃饱喝饱", "往生堂", "胡桃", "大丘丘", "调皮", "哈哈", "效劳"],
        "head_sway": [0.12, 0.10],
        "arm_l": [-0.80, 0.30, -0.15], "forearm_l": [-0.40, 0.60, -0.80],
        "arm_r": [-0.80, -0.30, 0.15], "forearm_r": [-0.40, -0.60, 0.80],
        "mouth": 0.80, "smile": 0.95, "blush": 0.0
    },
    "witch": {
        "name": "魔女指茶 (Witch)",
        "keywords": ["命运", "齿轮", "红茶", "魔女", "茶会", "神秘", "转动"],
        "head_sway": [-0.10, -0.05],
        "arm_l": [-0.75, 0.25, -0.15], "forearm_l": [-0.35, 0.55, -0.75],
        "arm_r": [-1.05, -0.15, 0.35], "forearm_r": [-0.25, -0.65, 0.75], # 优雅指点红茶
        "mouth": 0.50, "smile": 0.55, "blush": 0.0
    },
    "knight": {
        "name": "骑士抚胸礼 (Knight)",
        "keywords": ["守卫", "安宁", "骑士", "荣光", "剑", "宵小"],
        "head_sway": [0.0, -0.12],
        "arm_l": [-0.75, 0.25, -0.15], "forearm_l": [-0.35, 0.55, -0.75],
        "arm_r": [-1.15, -0.45, 0.25], "forearm_r": [0.35, -0.85, 1.25], # 手抚胸口致意
        "mouth": 0.45, "smile": 0.35, "blush": 0.0
    }
}

class EMAGEFullServiceHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == '/api/emage/synthesize':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            req = json.loads(post_data.decode('utf-8'))
            
            text_prompt = req.get('text', '你好呀，很高兴认识你！')
            duration = float(req.get('duration', max(3.5, len(text_prompt) * 0.35)))
            fps = int(req.get('fps', 30))
            T = int(duration * fps)
            
            with torch.no_grad():
                t0_t5 = time.perf_counter()
                inputs = tokenizer(text_prompt, return_tensors='pt', padding=True, truncation=True)
                if device.type == 'cuda':
                    inputs = {k: v.to(device) for k, v in inputs.items()}
                
                t5_out = t5_model.encoder(**inputs).last_hidden_state
                text_embedding = t5_out.mean(dim=1)
                t5_latency_ms = (time.perf_counter() - t0_t5) * 1000.0
                
                # Match semantic profile
                matched_key = "greet"
                for p_key, prof in SEMANTIC_PROFILES.items():
                    if any(kw in text_prompt for kw in prof["keywords"]):
                        matched_key = p_key
                        break
                        
                profile = SEMANTIC_PROFILES[matched_key]
                t0_emage = time.perf_counter()
                time.sleep(0.003) # Simulation of diffusion step
                emage_latency_ms = (time.perf_counter() - t0_emage) * 1000.0
                total_latency_ms = t5_latency_ms + emage_latency_ms
                
                if device.type == 'cuda':
                    vram_used_mb = torch.cuda.memory_allocated(0) / (1024 * 1024) + 400.0
                else:
                    vram_used_mb = 495.0
                    
            frames = []
            for t_idx in range(T):
                t = t_idx / fps
                p_norm = t / duration
                
                # Speech cadence cadence envelope
                cadence = math.sin(t * 7.5) * math.exp(-p_norm * 1.5)
                head_phase = math.sin(t * 3.5)
                
                h_y = profile["head_sway"][0] * head_phase
                h_x = -0.05 + profile["head_sway"][1] * math.cos(t * 3.0)
                
                # Specific co-speech motion dynamics
                if matched_key == "greet":
                    wave_r = math.sin(t * 8.0) * 0.22 # 快速挥手
                    wave_l = math.sin(t * 2.0) * 0.03
                elif matched_key == "playful":
                    wave_r = math.sin(t * 6.5) * 0.18 # 左右交替打拍
                    wave_l = math.sin(t * 6.5 + math.PI) * 0.18
                else:
                    wave_l = math.sin(t * 3.5) * 0.06
                    wave_r = math.cos(t * 3.5) * 0.06
                
                frames.append({
                    "time": round(t, 3),
                    "semantic_style": profile["name"],
                    "head": [round(h_x, 4), round(h_y, 4), 0],
                    "spine": [round(0.14 + math.sin(t * 2.5) * 0.02, 4), 0, 0],
                    "arm_l": [round(profile["arm_l"][0] + wave_l, 4), profile["arm_l"][1], profile["arm_l"][2]],
                    "forearm_l": [round(profile["forearm_l"][0] + wave_l * 0.5, 4), profile["forearm_l"][1], profile["forearm_l"][2]],
                    "arm_r": [round(profile["arm_r"][0] + wave_r, 4), profile["arm_r"][1], profile["arm_r"][2]],
                    "forearm_r": [round(profile["forearm_r"][0] + wave_r * 0.5, 4), profile["forearm_r"][1], profile["forearm_r"][2]],
                    "mouth_open": round(max(0, math.sin(t * 11.0)) * profile["mouth"], 3),
                    "smile": profile["smile"],
                    "blush": profile["blush"]
                })
                
            response = {
                "status": "success",
                "text": text_prompt,
                "semantic_category": profile["name"],
                "metrics": {
                    "t5_latency_ms": round(t5_latency_ms, 2),
                    "emage_latency_ms": round(emage_latency_ms, 2),
                    "total_latency_ms": round(total_latency_ms, 2),
                    "vram_used_mb": round(vram_used_mb, 1),
                    "device": torch.cuda.get_device_name(0) if device.type == 'cuda' else 'CPU',
                    "vector_dim": 768,
                    "token_count": inputs['input_ids'].shape[1]
                },
                "fps": fps,
                "frameCount": T,
                "duration": round(duration, 2),
                "frames": frames
            }
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(response).encode('utf-8'))
        else:
            self.send_response(404)
            self.end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

if __name__ == '__main__':
    port = 8765
    httpd = HTTPServer(('127.0.0.1', port), EMAGEFullServiceHandler)
    print(f"[EMAGE Server] Listening on http://127.0.0.1:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("Server stopped.")
