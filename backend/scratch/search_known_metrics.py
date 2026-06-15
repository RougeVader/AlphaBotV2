import os

frontend_dir = r"c:\Users\Ayush Khandwe\Desktop\New folder\frontend"
for root, dirs, files in os.walk(frontend_dir):
    # Ignore node_modules and .next directories
    dirs[:] = [d for d in dirs if d not in ('node_modules', '.next', '.git')]
    
    for f in files:
        if f.endswith(('.ts', '.tsx', '.js', '.jsx')):
            path = os.path.join(root, f)
            with open(path, 'r', encoding='utf-8', errors='ignore') as file:
                content = file.read()
                if "KNOWN_METRICS" in content:
                    print(f"Found in: {os.path.relpath(path, frontend_dir)}")
