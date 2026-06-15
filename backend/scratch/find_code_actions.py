import json
import os

transcript_path = r"C:\Users\Ayush Khandwe\.gemini\antigravity\brain\025fa7d0-3ce8-444e-8572-84222f65cd5b\.system_generated\logs\transcript.jsonl"
out_path = r"c:\Users\Ayush Khandwe\Desktop\New folder\backend\scratch\code_actions.txt"

if os.path.exists(transcript_path):
    with open(transcript_path, 'r', encoding='utf-8') as f, open(out_path, 'w', encoding='utf-8') as out:
        for line in f:
            data = json.loads(line)
            if data.get('type') in ('CODE_ACTION', 'VIEW_FILE'):
                out.write(f"Step {data.get('step_index')} [{data.get('type')}]:\n")
                content = data.get('content', '')
                out.write(content[:1000] + "\n")
                out.write("-" * 80 + "\n")
    print("Output written to scratch/code_actions.txt")
else:
    print("Transcript not found")
