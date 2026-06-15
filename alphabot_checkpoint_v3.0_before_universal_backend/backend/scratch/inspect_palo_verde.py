import sqlite3

conn = sqlite3.connect('palo_verde.db')
cur = conn.cursor()
cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'metrics_%'")
tbl = cur.fetchone()[0]
cur.execute(f"PRAGMA table_info({tbl})")
cols = cur.fetchall()
print("Columns for table:", tbl)
for col in cols:
    print(f"  {col[1]}: {col[2]}")

cur.execute(f"SELECT * FROM {tbl} LIMIT 1")
row = cur.fetchone()
names = [c[1] for c in cols]
print("\nSample Row:")
for name, val in zip(names, row):
    print(f"  {name}: {val}")

conn.close()
