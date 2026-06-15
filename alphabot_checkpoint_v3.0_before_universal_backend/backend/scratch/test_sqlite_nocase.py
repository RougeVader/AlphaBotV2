import sqlite3

conn = sqlite3.connect(":memory:")
cursor = conn.cursor()
cursor.execute("CREATE TABLE test (name TEXT)")
cursor.execute("INSERT INTO test VALUES ('Darlington Wind Unit 1')")
cursor.execute("INSERT INTO test VALUES ('Diablo Canyon Solar Unit 4')")
conn.commit()

# Test 1: COLLATE NOCASE with =
try:
    cursor.execute("SELECT * FROM test WHERE name = ? COLLATE NOCASE", ("darlington wind unit 1",))
    print("Test 1 Result:", cursor.fetchall())
except Exception as e:
    print("Test 1 Error:", e)

# Test 2: COLLATE NOCASE on the column in IN clause
try:
    cursor.execute("SELECT * FROM test WHERE name COLLATE NOCASE IN (?, ?)", ("darlington wind unit 1", "diablo canyon solar unit 4"))
    print("Test 2 Result:", cursor.fetchall())
except Exception as e:
    print("Test 2 Error:", e)

# Test 3: IN clause with COLLATE NOCASE at the end
try:
    cursor.execute("SELECT * FROM test WHERE name IN (?, ?) COLLATE NOCASE", ("darlington wind unit 1", "diablo canyon solar unit 4"))
    print("Test 3 Result:", cursor.fetchall())
except Exception as e:
    print("Test 3 Error:", e)

conn.close()
