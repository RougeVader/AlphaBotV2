import sys
sys.path.append(r"c:\Users\Ayush Khandwe\Desktop\New folder\backend")

from fastapi.testclient import TestClient
from main import app

client = TestClient(app)
response = client.get("/api/metadata")
print("Status Code:", response.status_code)
print("Response JSON:")
print(response.json())
