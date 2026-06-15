import os
import sys

# Append backend directory to path
sys.path.append(r"c:\Users\Ayush Khandwe\Desktop\New folder\backend")

from main import MetadataRegistry, discover_power_plants

registry = MetadataRegistry.get_instance()
print("Discovered Plants:", discover_power_plants())
print("Discovered Metrics:")
for m in sorted(registry.metrics.keys()):
    print(f"  {m}: {registry.metrics[m]}")

print("\nDiscovered Categoricals:")
for c in sorted(registry.categoricals.keys()):
    print(f"  {c}: values count = {len(registry.categoricals[c]['values'])}")
