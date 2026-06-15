import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch, MagicMock
import os
import sqlite3

# Import the objects we need to test
from main import app, MetadataRegistry, ConnectionManager, build_federated_query_parts, Blueprint, POWER_PLANTS, determine_unit_for_metric

# --- Test Setup and Teardown ---
@pytest.fixture(scope="module", autouse=True)
def setup_and_teardown_for_tests():
    """
    Overrides the MetadataRegistry singleton instance with mock metadata
    so that unit and integration tests run hermetically regardless of local database state.
    """
    registry = MetadataRegistry.get_instance()
    
    # Pre-populate with all metrics and categoricals used in test assertions
    registry.metrics = {
        "revenue": {"column": "revenue", "type": "NUMERIC"},
        "profit": {"column": "profit", "type": "NUMERIC"},
        "expenses": {"column": "expenses", "type": "NUMERIC"},
        "headcount": {"column": "headcount", "type": "NUMERIC"},
        "salary": {"column": "salary", "type": "NUMERIC"},
        "tax_liability": {"column": "tax_liability", "type": "NUMERIC"},
        "asset_value": {"column": "asset_value", "type": "NUMERIC"},
        "operating_cost": {"column": "operating_cost", "type": "NUMERIC"},
        "marketing_spend": {"column": "marketing_spend", "type": "NUMERIC"},
        "customer_count": {"column": "customer_count", "type": "NUMERIC"},
        "completion_percentage": {"column": "completion_percentage", "type": "NUMERIC"}
    }
    
    registry.categoricals = {
        "region": {"values": ["north", "south", "east", "west"]},
        "department": {"values": ["sales", "engineering", "digital", "finance"]},
        "project_type": {"values": ["Solar", "Wind", "Hybrid"]},
        "location": {"values": ["Gujarat", "Rajasthan"]},
        "state": {"values": ["Gujarat", "Rajasthan"]}
    }
    
    registry.db_schemas = {
        p: {
            "primary_table": f"metrics_{p}",
            "tables": [f"metrics_{p}"],
            "metrics": registry.metrics,
            "categoricals": registry.categoricals,
            "temporal": {"fy_year": {"type": "year"}, "record_date": {"type": "datetime"}}
        }
        for p in POWER_PLANTS
    }
    registry.temporal_cols = {"fy_year": {"type": "year"}, "record_date": {"type": "datetime"}}
    registry._initialized = True
    
    with patch('os.path.exists', return_value=True):
        yield

@pytest.fixture(scope="function")
def client():
    """Provides a new TestClient for each integration test."""
    with TestClient(app) as c:
        yield c

# --- Unit Tests for Logic ---
def test_build_federated_query_parts_simple():
    bp = Blueprint(metrics=["revenue"])
    where, metrics, params, sql_select, sql_group_by, sql_order_by = build_federated_query_parts(bp)
    assert where == ""
    assert metrics == ["revenue"]
    assert params == ()

def test_build_federated_query_parts_with_filters():
    bp = Blueprint(metrics=["profit"], filters=[{"column": "region", "value": "north"}])
    where, metrics, params, sql_select, sql_group_by, sql_order_by = build_federated_query_parts(bp)
    assert where == "region = ?"
    assert metrics == ["profit"]
    assert params == ("north",)

def test_build_federated_query_parts_with_timeframe():
    bp = Blueprint(metrics=["headcount"], timeframe={"type": "year", "value": "2025"})
    where, metrics, params, sql_select, sql_group_by, sql_order_by = build_federated_query_parts(bp)
    assert "fy_year = ?" in where
    assert metrics == ["headcount"]
    assert params == (2025,)

def test_build_federated_query_parts_with_in_clause():
    bp = Blueprint(metrics=["revenue"], filters=[
        {"column": "region", "value": "north"},
        {"column": "region", "value": "south"}
    ])
    where, metrics, params, sql_select, sql_group_by, sql_order_by = build_federated_query_parts(bp)
    assert "region IN (?, ?)" in where or "region IN (?,?)" in where
    assert "north" in params
    assert "south" in params

def test_build_federated_query_parts_rate_avg():
    bp = Blueprint(metrics=["completion_percentage"])
    where, metrics, params, sql_select, sql_group_by, sql_order_by = build_federated_query_parts(bp)
    assert "AVG(completion_percentage)" in sql_select

def test_build_federated_query_parts_between_date():
    bp = Blueprint(metrics=["revenue"], timeframe={"type": "date", "value": "2025-06-12"})
    where, metrics, params, sql_select, sql_group_by, sql_order_by = build_federated_query_parts(bp)
    assert "record_date BETWEEN ? AND ?" in where
    assert "2025-06-12 00:00:00" in params
    assert "2025-06-12 23:59:59" in params

def test_out_of_bounds_year_returns_error(client):
    registry = MetadataRegistry.get_instance()
    registry.categoricals['fy_year'] = {"values": [2024, 2025, 2026]}
    payload = {
        "raw_query": "revenue in 2030",
        "blueprint": {
            "metrics": ["revenue"],
            "timeframes": [{"type": "year", "value": "2030"}]
        }
    }
    response = client.post("/api/query", json=payload)
    data = response.json()
    assert response.status_code == 200
    assert data["status"] == "error"
    assert "outside the available database bounds" in data["message"]

# --- Integration Tests for API Endpoint ---
@patch('main.run_query_on_single_db')
def test_total_revenue_query(mock_run_query, client):
    mock_run_query.return_value = [{"revenue": 1000}]
    payload = {"raw_query": "what is total revenue", "blueprint": {"metrics": ["revenue"]}}
    response = client.post("/api/query", json=payload)
    data = response.json()
    assert response.status_code == 200
    assert data["status"] == "success"
    # Support dynamic database counts
    assert data["results"][0]["revenue"] == len(POWER_PLANTS) * 1000

@patch('main.run_query_on_single_db')
def test_filtered_headcount_query(mock_run_query, client):
    mock_run_query.return_value = [{"headcount": 10}]
    payload = {
        "raw_query": "headcount for digital",
        "blueprint": {"metrics": ["headcount"], "filters": [{"column": "department", "value": "digital"}]}
    }
    response = client.post("/api/query", json=payload)
    data = response.json()
    assert response.status_code == 200
    assert data["status"] == "success"
    # Support dynamic database counts
    assert data["results"][0]["headcount"] == len(POWER_PLANTS) * 10

@patch('main.run_query_on_single_db')
@patch('main.call_ollama_fallback')
def test_multi_metric_breakdown_query(mock_ollama, mock_run_query, client):
    mock_run_query.return_value = [{
        "label": "sales",
        "revenue": 900000.0, "profit": 100000.0, "expenses": 800000.0,
        "headcount": 42, "salary": 2192851.91, "tax_liability": 20745.16,
        "asset_value": 2251840.27, "operating_cost": 637608.24,
        "marketing_spend": 45036.81, "customer_count": 2885
    }]
    # Mock Ollama response to return the expected breakdown blueprint
    mock_ollama.return_value = Blueprint(
        operation="BREAKDOWN",
        metrics=["revenue", "profit", "expenses", "headcount", "salary", "customer_count"],
        filters=[
            {"column": "department", "value": "sales"},
            {"column": "plant", "value": "grand_gulf"},
            {"column": "region", "value": "south"}
        ],
        timeframe={"type": "timestamp", "value": "2026-08-13 19:00:00"}
    )
    
    payload = {
        "raw_query": "what is the breakdown of sales department in 2026-08-13 19:00:00 of grand_gulf in south region",
        "blueprint": {
            "operation": "BREAKDOWN",
            "metrics": [],  # Trigger default
            "filters": [
                {"column": "department", "value": "sales"},
                {"column": "plant", "value": "grand_gulf"},
                {"column": "region", "value": "south"}
            ],
            "timeframe": {"type": "timestamp", "value": "2026-08-13 19:00:00"}
        }
    }
    response = client.post("/api/query", json=payload)
    data = response.json()
    assert response.status_code == 200
    assert data["status"] == "success"
    assert len(data["results"]) == 1
    assert data["results"][0]["revenue"] == 900000.0
    assert data["results"][0]["profit"] == 100000.0
    assert data["results"][0]["expenses"] == 800000.0
    assert data["results"][0]["headcount"] == 42
    assert data["results"][0]["salary"] == 2192851.91
    assert data["results"][0]["customer_count"] == 2885
    assert data["metadata"]["sources"] == 1

def test_build_federated_query_parts_project_profile():
    bp = Blueprint(metrics=[], filters=[{"column": "project_id", "value": "PRJ-DAR-000000"}])
    where, metrics, params, sql_select, sql_group_by, sql_order_by = build_federated_query_parts(bp)
    assert "project_id = ?" in where
    assert sql_select == "*"
    assert params == ("PRJ-DAR-000000",)

@patch('main.run_query_on_single_db')
def test_project_profile_endpoint(mock_run_query, client):
    mock_run_query.return_value = [{"project_id": "PRJ-DAR-000000", "project_name": "Darlington Unit 1", "revenue": 100}]
    payload = {
        "raw_query": "PRJ-DAR-000000",
        "blueprint": {
            "metrics": [],
            "filters": [{"column": "project_id", "value": "PRJ-DAR-000000"}]
        }
    }
    response = client.post("/api/query", json=payload)
    data = response.json()
    assert response.status_code == 200
    assert data["status"] == "success"
    assert data["results"][0]["project_id"] == "PRJ-DAR-000000"
    assert data["sql_query"].startswith("SELECT *")

def test_build_federated_query_parts_project_name_profile():
    bp = Blueprint(metrics=[], filters=[{"column": "project_name", "value": "darlington solar unit 6"}])
    where, metrics, params, sql_select, sql_group_by, sql_order_by = build_federated_query_parts(bp)
    assert "project_name COLLATE NOCASE = ?" in where
    assert sql_select == "*"
    assert params == ("darlington solar unit 6",)

@patch('main.run_query_on_single_db')
def test_project_name_profile_routing_and_endpoint(mock_run_query, client):
    mock_run_query.return_value = [{"project_id": "PRJ-DAR-000005", "project_name": "Darlington Solar Unit 6", "revenue": 200}]
    payload = {
        "raw_query": "darlington solar unit 6",
        "blueprint": {
            "metrics": [],
            "filters": [{"column": "project_name", "value": "darlington solar unit 6"}]
        }
    }
    response = client.post("/api/query", json=payload)
    data = response.json()
    assert response.status_code == 200
    assert data["status"] == "success"
    assert data["results"][0]["project_name"] == "Darlington Solar Unit 6"
    assert data["sql_query"].startswith("SELECT *")

def test_determine_unit_for_metric():
    assert determine_unit_for_metric("completion_percentage") == "%"
    assert determine_unit_for_metric("delay_days") == "Days"
    assert determine_unit_for_metric("capacity_mw") == "MW"
    assert determine_unit_for_metric("headcount") == "Count"
    assert determine_unit_for_metric("revenue") == "₹ Cr"

def test_health_check(client):
    response = client.get("/")
    assert response.status_code == 200
    assert response.json() == {"status": "online"}

def test_build_federated_query_parts_year_range_expansion():
    # Test that year range is expanded into individual years
    bp = Blueprint(
        metrics=["revenue"],
        timeframe={"type": "year_range", "value": "2022-2026"}
    )
    where, metrics, params, sql_select, sql_group_by, sql_order_by = build_federated_query_parts(bp)
    assert "fy_year IN (?,?,?,?,?)" in where
    assert params == (2022, 2023, 2024, 2025, 2026)

@patch('main.run_query_on_single_db')
def test_single_site_temporal_comparison_groups_by_year(mock_run_query, client):
    # Configure mock registry allowed years
    registry = MetadataRegistry.get_instance()
    registry.categoricals['fy_year'] = {"values": [2022, 2023, 2024, 2025, 2026]}
    
    # Mocking single plant DB call returning yearly breakdown rows
    mock_run_query.return_value = [
        {"label": 2022, "revenue": 1000},
        {"label": 2023, "revenue": 1200},
    ]
    payload = {
        "raw_query": "compare the revenue of solar in grand_gulf from year 2022-2026",
        "blueprint": {
            "operation": "COMPARE",
            "metrics": ["revenue"],
            "filters": [
                {"column": "project_type", "value": "Solar"},
                {"column": "plant", "value": "grand_gulf"}
            ],
            "timeframe": {"type": "year_range", "value": "2022-2026"}
        }
    }
    response = client.post("/api/query", json=payload)
    data = response.json()
    assert response.status_code == 200
    assert data["status"] == "success"
    # It should not collapse into a single Grand Gulf site row because it is single-site temporal comparison.
    # Instead, it should group by label (year).
    assert len(data["results"]) == 2
    assert data["results"][0]["label"] == 2022
    assert data["results"][0]["revenue"] == 1000
    assert data["results"][1]["label"] == 2023
    assert data["results"][1]["revenue"] == 1200

def test_schema_engine_classifies_numeric_as_metric():
    from main import DynamicSchemaEngine, create_engine, text
    # Create in-memory SQLite DB
    engine = create_engine("sqlite:///:memory:")
    with engine.connect() as conn:
        conn.execute(text("CREATE TABLE metrics_test (id INTEGER PRIMARY KEY, sales REAL, city TEXT, fy_year INTEGER)"))
        conn.execute(text("INSERT INTO metrics_test (sales, city, fy_year) VALUES (150.0, 'Delhi', 2025)"))
        conn.commit()
    
    schema = DynamicSchemaEngine.classify("test", engine)
    assert "metrics_test" in schema["tables"]
    assert schema["primary_table"] == "metrics_test"
    assert "sales" in schema["metrics"]
    assert "city" in schema["categoricals"]
    assert "Delhi" in schema["categoricals"]["city"]["values"]
    assert "fy_year" in schema["temporal"]
    assert schema["temporal"]["fy_year"]["type"] == "year"

def test_schema_engine_excludes_id_columns():
    from main import DynamicSchemaEngine, create_engine, text
    engine = create_engine("sqlite:///:memory:")
    with engine.connect() as conn:
        conn.execute(text("CREATE TABLE metrics_test (id INTEGER, project_id TEXT, cost REAL)"))
        conn.execute(text("INSERT INTO metrics_test (id, project_id, cost) VALUES (1, 'P1', 500.0)"))
        conn.commit()
    
    schema = DynamicSchemaEngine.classify("test", engine)
    assert "cost" in schema["metrics"]
    assert "id" not in schema["metrics"]
    assert "project_id" not in schema["metrics"]

def test_metadata_endpoint_returns_db_schemas(client):
    response = client.get("/api/metadata")
    assert response.status_code == 200
    data = response.json()
    assert "databases" in data
    for plant in POWER_PLANTS:
        assert plant in data["databases"]
        assert "primary_table" in data["databases"][plant]
        assert "metrics" in data["databases"][plant]

def test_build_federated_query_parts_dimensional_comparison():
    bp = Blueprint(
        metrics=["revenue"],
        filters=[
            {"column": "state", "value": "Gujarat"},
            {"column": "state", "value": "Rajasthan"}
        ],
        timeframe={"type": "year_range", "value": "2020-2023"}
    )
    where, metrics, params, sql_select, sql_group_by, sql_order_by = build_federated_query_parts(bp)
    assert "state IN (?, ?)" in where or "state IN (?,?)" in where
    assert "state as comparison_group" in sql_select
    assert "GROUP BY fy_year, state" in sql_group_by
    assert "ORDER BY label ASC, comparison_group ASC" in sql_order_by

@patch('main.run_query_on_single_db')
def test_federated_query_processor_dimensional_comparison(mock_run_query, client):
    # Setup mock registry allowed years
    registry = MetadataRegistry.get_instance()
    registry.categoricals['fy_year'] = {"values": [2020, 2021, 2022, 2023]}
    
    # Mocking single plant DB calls
    mock_run_query.return_value = [
        {"label": 2020, "comparison_group": "Gujarat", "revenue": 1000},
        {"label": 2020, "comparison_group": "Rajasthan", "revenue": 1200},
        {"label": 2021, "comparison_group": "Gujarat", "revenue": 1100},
        {"label": 2021, "comparison_group": "Rajasthan", "revenue": 1300},
    ]
    
    payload = {
        "raw_query": "compare the revenue of gujarat and rajasthan from 2020 to 2023",
        "blueprint": {
            "operation": "COMPARE",
            "metrics": ["revenue"],
            "filters": [
                {"column": "state", "value": "Gujarat"},
                {"column": "state", "value": "Rajasthan"}
            ],
            "timeframe": {"type": "year_range", "value": "2020-2023"}
        }
    }
    response = client.post("/api/query", json=payload)
    data = response.json()
    assert response.status_code == 200
    assert data["status"] == "success"
    # Ensure it aggregated the groups correctly and did not collapse them by site
    assert len(data["results"]) == 4
    assert data["results"][0] == {"label": 2020, "comparison_group": "Gujarat", "revenue": len(POWER_PLANTS) * 1000}
    assert data["results"][1] == {"label": 2020, "comparison_group": "Rajasthan", "revenue": len(POWER_PLANTS) * 1200}






