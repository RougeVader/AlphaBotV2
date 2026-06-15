import json

log_path = r"C:\Users\Ayush Khandwe\.gemini\antigravity\brain\025fa7d0-3ce8-444e-8572-84222f65cd5b\.system_generated\logs\transcript.jsonl"

with open(log_path, 'r', encoding='utf-8') as f:
    for i, line in enumerate(f):
        if "profit" in line:
            data = json.loads(line)
            content = data.get("content", "")
            if len(content) > 100:
                print(f"Line {i} (type={data.get('type')}, status={data.get('status')}): {content[:300]}")
            else:
                print(f"Line {i}: {data}")
            if i > 2000:
                break
                
print("Search complete.")
