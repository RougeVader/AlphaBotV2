import httpx

try:
    resp = httpx.get("http://localhost:8000/api/metadata")
    print("Status code:", resp.status_code)
    print("JSON:", resp.json())
except Exception as e:
    print("Error connecting to backend:", e)
