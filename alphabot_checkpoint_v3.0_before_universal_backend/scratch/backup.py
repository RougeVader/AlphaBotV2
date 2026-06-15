import os
import shutil

def backup():
    src_dir = "c:\\Users\\Ayush Khandwe\\Desktop\\New folder"
    dst_dir = "c:\\Users\\Ayush Khandwe\\Desktop\\New folder\\alphabot_checkpoint_v3.0_before_universal_backend"
    
    # Ensure destination is clear
    if os.path.exists(dst_dir):
        shutil.rmtree(dst_dir, ignore_errors=True)
    os.makedirs(dst_dir, exist_ok=True)
    
    ignore_patterns = {
        '.db', '__pycache__', '.pytest_cache', '.git', '.next', 'node_modules', 
        'alphabot_checkpoint_v2.1_audit_start', 'alphabot_checkpoint_v3.0_before_universal_backend',
        'venv', '.venv'
    }

    for root, dirs, files in os.walk(src_dir):
        # Filter directories to avoid walking into ignored ones
        dirs[:] = [d for d in dirs if d not in ignore_patterns]
        
        # Determine relative path from src_dir
        rel_path = os.path.relpath(root, src_dir)
        if rel_path == ".":
            current_dst = dst_dir
        else:
            current_dst = os.path.join(dst_dir, rel_path)
            os.makedirs(current_dst, exist_ok=True)
            
        for file in files:
            ext = os.path.splitext(file)[1].lower()
            if ext == '.db' or file in ignore_patterns:
                continue
            
            src_file = os.path.join(root, file)
            dst_file = os.path.join(current_dst, file)
            
            try:
                shutil.copy2(src_file, dst_file)
            except Exception as e:
                print(f"Error copying {src_file}: {e}")

if __name__ == "__main__":
    backup()
    print("Backup completed successfully.")
