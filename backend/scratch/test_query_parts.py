import sys
sys.path.append(r"c:\Users\Ayush Khandwe\Desktop\New folder\backend")

from main import Blueprint, build_federated_query_parts, MetadataRegistry

# Initialize registry with mock metrics
registry = MetadataRegistry.get_instance()
registry.metrics = {
    "revenue": {"column": "revenue", "type": "NUMERIC"},
    "budget_remaining": {"column": "budget_remaining", "type": "NUMERIC"},
}
registry.categoricals = {
    "project_id": {"values": ["PRJ-PAL-000005"]}
}
registry._initialized = True

bp = Blueprint(
    metrics=["budget_remaining"],
    filters=[{"column": "project_id", "value": "PRJ-PAL-000005"}]
)

where, metrics, params, sql_select, sql_group_by, sql_order_by = build_federated_query_parts(bp)
print("Where clause:", where)
print("Metrics list:", metrics)
print("SQL Select:", sql_select)
print("Params:", params)
