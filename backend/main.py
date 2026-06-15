import time
import sqlite3
import json
import httpx
import logging
import asyncio
import os
import re
import glob
from fastapi import FastAPI, Request, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any, Union
from sqlalchemy import create_engine, inspect, text

# --- Dynamic Federated Configuration ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

def discover_power_plants():
    """Scans the directory for .db files and treats them as data sources."""
    ignore_list = ['benchmark_test.db', 'market_intel.db', 'corporate_metrics_db_7.db', 'corporate_metrics_db_8.db']
    db_files = glob.glob(os.path.join(BASE_DIR, "*.db"))
    plants = []
    for f in db_files:
        name = os.path.basename(f)
        if name not in ignore_list:
            plants.append(os.path.splitext(name)[0])
    return sorted(plants)

class ConnectionManager:
    """
    Manages database connections via SQLAlchemy.
    Supports any dialect (sqlite, postgresql, mysql) through connection URL strings.
    Falls back to .db glob-scan if connections.json is absent.
    """
    _engines: Dict[str, Any] = {}   # db_key -> sqlalchemy Engine
    _db_keys: List[str] = []

    @classmethod
    def load(cls):
        cls._engines.clear()
        config_path = os.path.join(BASE_DIR, "connections.json")
        if os.path.exists(config_path):
            try:
                with open(config_path) as f:
                    cfg = json.load(f)
                ignore = set(cfg.get("ignore", []))
                for key, url in cfg.get("databases", {}).items():
                    if key not in ignore:
                        # Resolve relative sqlite paths to absolute
                        if url.startswith("sqlite:///") and not url.startswith("sqlite:////"):
                            rel = url[len("sqlite:///"):]
                            url = f"sqlite:///{os.path.join(BASE_DIR, rel)}"
                        cls._engines[key] = create_engine(url, pool_pre_ping=True)
            except Exception as e:
                logging.error(f"Error loading connections.json: {e}. Falling back to discovery.")
                cls._engines.clear()
        
        # Fallback if config failed/empty or was absent
        if not cls._engines:
            for name in discover_power_plants():
                path = os.path.join(BASE_DIR, f"{name}.db")
                cls._engines[name] = create_engine(f"sqlite:///{path}")
        
        cls._db_keys = sorted(cls._engines.keys())
        return cls._db_keys

    @classmethod
    def engine(cls, key: str):
        return cls._engines.get(key)

    @classmethod
    def keys(cls) -> List[str]:
        return cls._db_keys

class DynamicSchemaEngine:
    """
    Fully dynamic schema introspector. Works with any SQL database.
    Classifies columns as: METRIC (numeric), DIMENSION (text/categorical),
    TEMPORAL (date/year-like), or KEY (excluded id columns).
    """
    METRIC_EXCLUDE = re.compile(r'(^id$|_id$|^pk$)', re.I)
    NUMERIC_TYPES  = {'INTEGER','INT','BIGINT','SMALLINT','REAL','FLOAT',
                      'DOUBLE','NUMERIC','DECIMAL','NUMBER','MONEY'}
    TEXT_TYPES     = {'TEXT','VARCHAR','CHAR','NVARCHAR','STRING','CLOB'}
    DATE_TYPES     = {'DATE','DATETIME','TIMESTAMP', 'TIMESTAMP WITHOUT TIME ZONE'}
    YEAR_COL_NAMES = re.compile(r'(year|fy_year|fiscal_year)', re.I)
    DATE_COL_NAMES = re.compile(r'(date|time|created_at|updated_at)', re.I)

    @staticmethod
    def classify(db_key: str, engine) -> Dict[str, Any]:
        result = {
            "tables": [], "primary_table": None,
            "metrics": {}, "categoricals": {}, "temporal": {}
        }
        try:
            insp = inspect(engine)
            tables = [t for t in insp.get_table_names()
                      if not t.lower().startswith('sqlite_') and not t.lower().startswith('pg_')]
            result["tables"] = tables
            if not tables:
                return result

            # Choose primary table (prefer metrics_* prefix, else first table)
            primary = next((t for t in tables if t.lower().startswith('metrics_')), tables[0])
            result["primary_table"] = primary

            cols = insp.get_columns(primary)
            with engine.connect() as conn:
                for col in cols:
                    name = col["name"]
                    raw_type = str(col["type"]).upper().split("(")[0].strip()

                    # Skip primary/foreign key columns, but keep project_id
                    if DynamicSchemaEngine.METRIC_EXCLUDE.search(name) and name.lower() != 'project_id':
                        continue

                    if raw_type in DynamicSchemaEngine.NUMERIC_TYPES:
                        # Year-like numeric columns -> temporal
                        if DynamicSchemaEngine.YEAR_COL_NAMES.search(name):
                            result["temporal"][name] = {"type": "year"}
                            # Sample year values for boundary checks
                            try:
                                rows = conn.execute(
                                    text(f"SELECT DISTINCT {name} FROM {primary} "
                                         f"WHERE {name} IS NOT NULL LIMIT 50")
                                ).fetchall()
                                result["categoricals"][name] = {
                                    "values": [int(r[0]) for r in rows if str(r[0]).isdigit()]
                                }
                            except Exception as ex:
                                logging.error(f"Error sampling years for {name} in {db_key}: {ex}")
                        else:
                            result["metrics"][name] = {"column": name, "type": raw_type}

                    elif raw_type in DynamicSchemaEngine.TEXT_TYPES:
                        # Date-name text columns -> temporal
                        if DynamicSchemaEngine.DATE_COL_NAMES.search(name):
                            result["temporal"][name] = {"type": "datetime"}
                        else:
                            # Sample unique categorical values
                            limit = 100 if 'id' in name.lower() else 50
                            try:
                                rows = conn.execute(
                                    text(f"SELECT DISTINCT {name} FROM {primary} "
                                         f"WHERE {name} IS NOT NULL LIMIT {limit}")
                                ).fetchall()
                                result["categoricals"][name] = {
                                    "values": [r[0] for r in rows if r[0] is not None]
                                }
                            except Exception as ex:
                                logging.error(f"Error sampling values for {name} in {db_key}: {ex}")

                    elif raw_type in DynamicSchemaEngine.DATE_TYPES:
                        result["temporal"][name] = {"type": "datetime"}

        except Exception as e:
            logging.error(f"Schema reflection error on {db_key}: {e}")
        return result

POWER_PLANTS = discover_power_plants()
OLLAMA_URL = "http://localhost:11434/api/generate"
OLLAMA_MODEL = "phi3.5:3.8b"

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("alphabot-federated-engine")


# --- Metadata Registry (Singleton / Auto-Discovery) ---
class MetadataRegistry:
    _instance = None
    _last_checked = 0.0
    _db_mtimes = {}

    @classmethod
    def get_instance(cls):
        if cls._instance is None:
            cls._instance = cls.__new__(cls)
            cls._instance._initialized = False
            cls._instance.metrics = {}
            cls._instance.categoricals = {}
            cls._instance.db_schemas = {}
            cls._instance.temporal_cols = {}
            cls._instance.initialize()
            cls._db_mtimes = {}
            cls._config_mtime = 0.0
            config_path = os.path.join(BASE_DIR, "connections.json")
            if os.path.exists(config_path):
                cls._config_mtime = os.path.getmtime(config_path)
            for db in ConnectionManager.keys():
                engine = ConnectionManager.engine(db)
                if engine and engine.dialect.name == "sqlite":
                    path = os.path.join(BASE_DIR, f"{db}.db")
                    if os.path.exists(path):
                        cls._db_mtimes[db] = os.path.getmtime(path)
        else:
            now = time.time()
            if now - cls._last_checked > 5.0:
                cls._last_checked = now
                config_path = os.path.join(BASE_DIR, "connections.json")
                config_mtime = os.path.getmtime(config_path) if os.path.exists(config_path) else 0.0
                
                needs_reload = False
                if config_mtime != getattr(cls, "_config_mtime", 0.0):
                    needs_reload = True
                else:
                    current_dbs = ConnectionManager.keys()
                    for db in current_dbs:
                        engine = ConnectionManager.engine(db)
                        if engine and engine.dialect.name == "sqlite":
                            path = os.path.join(BASE_DIR, f"{db}.db")
                            if os.path.exists(path):
                                mtime = os.path.getmtime(path)
                                if cls._db_mtimes.get(db) != mtime:
                                    needs_reload = True
                                    break
                if needs_reload:
                    logger.info("🔄 Schema drift or DB file/config modification detected! Hot-reloading registry...")
                    cls._instance._initialized = False
                    cls._instance.initialize()
                    cls._db_mtimes.clear()
                    cls._config_mtime = config_mtime
                    for db in ConnectionManager.keys():
                        engine = ConnectionManager.engine(db)
                        if engine and engine.dialect.name == "sqlite":
                            path = os.path.join(BASE_DIR, f"{db}.db")
                            if os.path.exists(path):
                                cls._db_mtimes[db] = os.path.getmtime(path)
        return cls._instance

    def initialize(self):
        if self._initialized: return
        start_init = time.perf_counter()
        
        global POWER_PLANTS
        POWER_PLANTS = ConnectionManager.load()
        logger.info(f"🚀 Found {len(POWER_PLANTS)} dynamic data sources: {POWER_PLANTS}")
        
        self.metrics.clear()
        self.categoricals.clear()
        self.db_schemas = {}
        self.temporal_cols = {}

        if not POWER_PLANTS:
            logger.error("FATAL: No database files found.")
            return

        cache_path = os.path.join(BASE_DIR, "metadata_cache.json")
        cache_data = {}
        if os.path.exists(cache_path):
            try:
                with open(cache_path, "r", encoding="utf-8") as f:
                    loaded = json.load(f)
                    cache_data = loaded.get("databases", {})
            except Exception as e:
                logger.error(f"Error loading metadata_cache.json: {e}")

        new_cache_data = {}
        cache_dirty = False

        for plant in POWER_PLANTS:
            engine = ConnectionManager.engine(plant)
            if not engine: continue
            
            db_path = os.path.join(BASE_DIR, f"{plant}.db")
            current_mtime = os.path.getmtime(db_path) if os.path.exists(db_path) else 0.0
            
            cached_entry = cache_data.get(plant, {})
            cached_mtime = cached_entry.get("mtime", -1.0)
            
            if cached_mtime == current_mtime and "schema" in cached_entry:
                schema = cached_entry["schema"]
                new_cache_data[plant] = cached_entry
            else:
                logger.info(f"🔍 Cache miss or drift for {plant}. Introspecting database...")
                schema = DynamicSchemaEngine.classify(plant, engine)
                new_cache_data[plant] = {
                    "mtime": current_mtime,
                    "schema": schema
                }
                cache_dirty = True
            
            self.db_schemas[plant] = schema
            
            for col, meta in schema["metrics"].items():
                self.metrics.setdefault(col, meta)
            for col, cat in schema["categoricals"].items():
                existing = self.categoricals.setdefault(col, {"values": set()})
                existing["values"].update(cat["values"])
            for col, temp in schema["temporal"].items():
                self.temporal_cols.setdefault(col, temp)

        if cache_dirty:
            try:
                with open(cache_path, "w", encoding="utf-8") as f:
                    json.dump({"databases": new_cache_data}, f, indent=2, ensure_ascii=False)
                logger.info("💾 Saved updated metadata cache to metadata_cache.json")
            except Exception as e:
                logger.error(f"Error saving metadata_cache.json: {e}")

        for k in self.categoricals:
            self.categoricals[k]["values"] = list(self.categoricals[k]["values"])

        self._initialized = True
        init_ms = (time.perf_counter() - start_init) * 1000
        logger.info(f"✅ Schema Discovery Complete in {init_ms:.2f}ms. Metrics: {list(self.metrics.keys())}")


# --- Pydantic Models ---
class Blueprint(BaseModel):
    operation: Optional[str] = "SUM"
    metrics: List[str] = []
    filters: List[Dict[str, str]] = []
    timeframe: Optional[Dict[str, str]] = None
    timeframes: List[Dict[str, str]] = [] 
    is_range: bool = False
    comparison: Optional[Dict[str, Any]] = None
    breakdown_by: Optional[str] = None

class QueryBlueprintPayload(BaseModel):
    raw_query: str
    blueprint: Optional[Blueprint] = None
    force_llm: bool = False
    parsing_metadata: Optional[Dict[str, Any]] = None

# --- Federated Query Engine ---
async def run_query_on_single_db(plant: str, sql: str, params: tuple) -> List[Dict]:
    engine = ConnectionManager.engine(plant)
    if not engine:
        return []
    
    registry = MetadataRegistry.get_instance()
    primary_table = registry.db_schemas.get(plant, {}).get("primary_table", f"metrics_{plant}")
    
    final_sql = sql.replace("{table_name}", primary_table)
    
    # Dialect translation and parameter binding conversion
    dialect_name = engine.dialect.name
    is_sqlite = (dialect_name == "sqlite")
    
    if dialect_name == "postgresql":
        # Translate strftime('%Y-%m', col) to to_char(col, 'YYYY-MM')
        final_sql = re.sub(r"strftime\('%Y-%m',\s*([^)]+)\)", r"to_char(\1, 'YYYY-MM')", final_sql, flags=re.I)
        # Remove SQLite specific COLLATE NOCASE
        final_sql = final_sql.replace("COLLATE NOCASE", "")
    elif dialect_name == "mysql":
        # Translate strftime('%Y-%m', col) to DATE_FORMAT(col, '%Y-%m')
        final_sql = re.sub(r"strftime\('%Y-%m',\s*([^)]+)\)", r"DATE_FORMAT(\1, '%Y-%m')", final_sql, flags=re.I)
        # Remove SQLite specific COLLATE NOCASE
        final_sql = final_sql.replace("COLLATE NOCASE", "")
        
    loop = asyncio.get_event_loop()
    def query():
        with engine.connect() as conn:
            if is_sqlite:
                result = conn.exec_driver_sql(final_sql, params)
                return [dict(row._mapping) for row in result]
            else:
                # Convert ? placeholders to named params :p0, :p1, ...
                param_dict = {}
                translated_sql = ""
                placeholder_idx = 0
                parts = final_sql.split('?')
                for i, part in enumerate(parts):
                    translated_sql += part
                    if i < len(parts) - 1:
                        param_name = f"p{placeholder_idx}"
                        translated_sql += f":{param_name}"
                        val = params[placeholder_idx] if placeholder_idx < len(params) else None
                        param_dict[param_name] = val
                        placeholder_idx += 1
                result = conn.execute(text(translated_sql), param_dict)
                return [dict(row._mapping) for row in result]
                
    try:
        return await loop.run_in_executor(None, query)
    except Exception as e:
        logger.error(f"Query Error on {plant}: {e}")
        return []

def build_federated_query_parts(bp: Blueprint) -> (str, List[str], tuple, str, str, str):
    registry = MetadataRegistry.get_instance()
    where_clauses, params = [], []
    valid_dims = list(registry.categoricals.keys())
    
    # Resolve dynamic temporal columns
    temporal_cols = getattr(registry, "temporal_cols", {})
    year_col = next(
        (col for col, meta in temporal_cols.items() if meta["type"] == "year"),
        "fy_year"  # safe default
    )
    date_col = next(
        (col for col, meta in temporal_cols.items() if meta["type"] == "datetime"),
        "record_date"
    )
    
    # Group filter values by target database column (Case 1: Dual-Dimension Collision)
    col_to_filters = {}
    for f in bp.filters:
        col, val = f['column'].lower(), f['value']
        target = None
        if col in valid_dims: target = col
        elif col == "project_id": target = "project_id"
        elif col == "project_name": target = "project_name"
        elif col == "department" and "project_type" in valid_dims: target = "project_type"
        elif col == "site" and "location" in valid_dims: target = "location"
        elif col == "plant": continue
        
        if target:
            # Case-normalization in Python to match exact DB casing and leverage index
            allowed_vals = registry.categoricals.get(target, {}).get("values", [])
            normalized_val = val
            for av in allowed_vals:
                if str(av).lower() == str(val).lower():
                    normalized_val = av
                    break
            if target not in col_to_filters:
                col_to_filters[target] = []
            col_to_filters[target].append(normalized_val)
        else:
            where_clauses.append("1 = 0") # Block whole-table leak if filter is invalid

    for target, vals in col_to_filters.items():
        collation = " COLLATE NOCASE" if target == 'project_name' else ""
        if len(vals) == 1:
            where_clauses.append(f"{target}{collation} = ?")
            params.append(vals[0])
        else:
            placeholders = ",".join(["?"] * len(vals))
            where_clauses.append(f"{target}{collation} IN ({placeholders})")
            params.extend(vals)

    # 2. Numeric Comparisons (e.g., delay < 25)
    if bp.comparison:
        comp = bp.comparison
        c_metric = comp.get('metric')
        c_op = comp.get('operator')
        c_val = comp.get('value')
        if c_metric in registry.metrics and c_op in ['<', '>', '=', '<=', '>=']:
            where_clauses.append(f"{c_metric} {c_op} ?")
            params.append(c_val)

    if bp.timeframe and not bp.timeframes:
        bp.timeframes = [bp.timeframe]
    
    # Expand year ranges in timeframes list for performance and accuracy
    expanded_timeframes = []
    for tf in bp.timeframes:
        val_str = str(tf.get('value', '')).replace("FY", "").strip()
        range_match = re.match(r'^(\d{4})\s*(?:-|to)\s*(\d{4})$', val_str)
        if range_match:
            start_yr = int(range_match.group(1))
            end_yr = int(range_match.group(2))
            if start_yr > end_yr:
                start_yr, end_yr = end_yr, start_yr
            for y in range(start_yr, end_yr + 1):
                expanded_timeframes.append({"type": "year", "value": str(y)})
        else:
            expanded_timeframes.append(tf)
    bp.timeframes = expanded_timeframes

    if bp.timeframes:
        dates_val = []
        years_val = []
        for tf in bp.timeframes:
            val_str = str(tf.get('value', '')).replace("FY", "")
            if tf.get('type') == 'date' or re.match(r'^\d{4}-\d{2}-\d{2}$', val_str):
                dates_val.append(val_str[:10])
            else:
                if val_str.isdigit():
                    years_val.append(int(val_str))
                else:
                    years_val.append(val_str)
                    
        # Apply date filters (Case 4: Timestamp Date Range Safety)
        for d in dates_val:
            where_clauses.append(f"{date_col} BETWEEN ? AND ?")
            params.extend([f"{d} 00:00:00", f"{d} 23:59:59"])
            
        # Apply year filters (Indexed lookup)
        if years_val:
            if len(years_val) == 1:
                where_clauses.append(f"{year_col} = ?")
                params.append(years_val[0])
            else:
                placeholders = ",".join(["?"] * len(years_val))
                where_clauses.append(f"{year_col} IN ({placeholders})")
                params.extend(years_val)

    # Detect profile request
    is_profile_request = ('project_id' in col_to_filters or 'project_name' in col_to_filters) and not bp.metrics
    
    # Allow empty metric_cols ONLY IF is_profile_request is true
    metric_cols = [m for m in bp.metrics if m in registry.metrics]
    if not metric_cols and not is_profile_request:
        metric_cols = ["revenue"]

    sql_group_by, sql_order_by, group_col = "", "", None
    
    # Detect comparison_col
    comparison_col = None
    for col, vals in col_to_filters.items():
        if len(vals) > 1 and col not in ['plant', 'project_id', 'project_name']:
            comparison_col = col
            break

    if is_profile_request:
        sql_select = "*"
    else:
        op = bp.operation.upper() if bp.operation else "SUM"
        is_time_grouping = len(bp.timeframes) > 1 or op in ["GRAPH", "TREND"]
        
        if is_time_grouping:
            if len(bp.timeframes) > 1:
                if comparison_col:
                    group_col = f"{year_col} as label, {comparison_col} as comparison_group"
                    sql_group_by = f"GROUP BY {year_col}, {comparison_col}"
                    sql_order_by = "ORDER BY label ASC, comparison_group ASC"
                else:
                    group_col = f"{year_col} as label"
                    sql_group_by = f"GROUP BY {year_col}"
                    sql_order_by = "ORDER BY label ASC"
            else:
                if comparison_col:
                    group_col = f"strftime('%Y-%m', {date_col}) as label, {comparison_col} as comparison_group"
                    sql_group_by = f"GROUP BY strftime('%Y-%m', {date_col}), {comparison_col}"
                    sql_order_by = "ORDER BY label ASC, comparison_group ASC"
                else:
                    group_col = f"strftime('%Y-%m', {date_col}) as label"
                    sql_group_by = f"GROUP BY strftime('%Y-%m', {date_col})"
                    sql_order_by = "ORDER BY label ASC"
        elif op in ["BREAKDOWN", "COMPARE"] or comparison_col:
            # Resolve target breakdown column
            group_col_name = comparison_col
            
            if not group_col_name and bp.breakdown_by:
                bby = bp.breakdown_by.lower().strip()
                if bby in valid_dims: group_col_name = bby
                elif bby == "department" and "project_type" in valid_dims: group_col_name = "project_type"
                elif bby == "site" and "location" in valid_dims: group_col_name = "location"
                
            if not group_col_name:
                filtered_cols = [f['column'].lower() for f in bp.filters]
                filtered_db_cols = []
                for c in filtered_cols:
                    if c == "department": filtered_db_cols.append("project_type")
                    elif c in ["plant", "site"]: filtered_db_cols.append("location")
                    else: filtered_db_cols.append(c)
                
                group_candidates = ['project_type', 'location', 'state', 'category', 'contractor_name']
                for cand in group_candidates:
                    if cand in valid_dims and cand not in filtered_db_cols:
                        group_col_name = cand
                        break
                        
            if not group_col_name:
                group_col_name = "project_type" if "project_type" in valid_dims else "location"
                
            group_col = f"{group_col_name} as label"
            sql_group_by = f"GROUP BY {group_col_name}"
            sql_order_by = "ORDER BY label ASC"
            
        select_parts = []
        if group_col:
            select_parts.append(group_col)
        
        for m in metric_cols:
            # Check if metric is actually a categorical column
            if m in registry.categoricals:
                select_parts.append(f"{m} as {m}")
            else:
                # Numeric aggregation
                is_rate_col = any(keyword in m.lower() for keyword in ['pct', 'percentage', 'delay', 'rate'])
                if is_rate_col and op in ["SUM", "AVERAGE", "AVG"]:
                    select_parts.append(f"AVG({m}) as {m}")
                else:
                    select_parts.append(f"SUM({m}) as {m}")
        sql_select = ", ".join(select_parts)
    where_str = " AND ".join(where_clauses)
    return where_str, metric_cols, tuple(params), sql_select, sql_group_by, sql_order_by


def levenshtein_dist(s1: str, s2: str) -> int:
    if len(s1) < len(s2):
        return levenshtein_dist(s2, s1)
    if len(s2) == 0:
        return len(s1)
    previous_row = range(len(s2) + 1)
    for i, c1 in enumerate(s1):
        current_row = [i + 1]
        for j, c2 in enumerate(s2):
            insertions = previous_row[j + 1] + 1
            deletions = current_row[j] + 1
            substitutions = previous_row[j] + (c1 != c2)
            current_row.append(min(insertions, deletions, substitutions))
        previous_row = current_row
    return previous_row[-1]

def determine_unit_for_metric(metric: str) -> str:
    m = metric.lower()
    if 'percentage' in m or 'pct' in m or 'rate' in m:
        return "%"
    elif 'delay' in m or 'days' in m:
        return "Days"
    elif 'capacity' in m or 'mw' in m:
        return "MW"
    elif 'headcount' in m or 'count' in m:
        return "Count"
    return "₹ Cr"

def interpolate_sql(sql_str: str, params: tuple) -> str:
    if not params:
        return sql_str
    parts = sql_str.split('?')
    interpolated = ""
    for i, part in enumerate(parts):
        interpolated += part
        if i < len(params):
            val = params[i]
            if isinstance(val, str):
                interpolated += f"'{val}'"
            elif val is None:
                interpolated += "NULL"
            else:
                interpolated += str(val)
    return interpolated

async def federated_query_processor(bp: Blueprint, raw_query: str, parsing_metadata: Optional[Dict] = None) -> Dict[str, Any]:
    registry = MetadataRegistry.get_instance()
    
    # 1. Detect if timeframe represents a range (multiple years/dates)
    is_timeframe_range = False
    if bp.timeframe and bp.timeframe.get('type') == 'year_range':
        is_timeframe_range = True
    elif bp.timeframes and len(bp.timeframes) > 1:
        is_timeframe_range = True

    # Case 9: Timeframe Boundary Guard with range support
    tf_list = bp.timeframes or ([bp.timeframe] if bp.timeframe else [])
    years_to_check = []
    for tf in tf_list:
        val_str = str(tf.get('value', '')).replace("FY", "").strip()
        range_match = re.match(r'^(\d{4})\s*(?:-|to)\s*(\d{4})$', val_str)
        if range_match:
            start_yr = int(range_match.group(1))
            end_yr = int(range_match.group(2))
            if start_yr > end_yr:
                start_yr, end_yr = end_yr, start_yr
            years_to_check.extend(range(start_yr, end_yr + 1))
            is_timeframe_range = True
        elif val_str.isdigit():
            years_to_check.append(int(val_str))
            
    if years_to_check:
        allowed_years = set(registry.categoricals.get('fy_year', {}).get('values', []))
        if allowed_years:
            for y in years_to_check:
                if y not in allowed_years:
                    logger.warning(f"⚠️ Validation Blocked: Year {y} is out of database bounds.")
                    return {
                        "status": "error",
                        "message": f"Ambiguity or error: The requested year {y} is outside the available database bounds ({min(allowed_years)} - {max(allowed_years)}).",
                        "results": []
                    }
                        
    # 2. Zero-Trust Dynamic Entity Validation & Fuzzy Recovery
    client_unknowns = (parsing_metadata or {}).get("unknown_tokens", [])
    filter_values = [str(f['value']).lower() for f in bp.filters]
    
    # Meaningful words check (ignore actions and fluff)
    meaningful_unknowns = [u.lower() for u in client_unknowns if len(u) > 2 and u.lower() not in [
        'across', 'sites', 'all', 'from', 'year', 'than', 'between', 'and', 'id', 'project', 'projects', 
        'is', 'are', 'was', 'were', 'been', 'being', 'am', 'be', 'the', 'of', 'for', 'with', 'what', 'which', 
        'who', 'whom', 'whose', 'where', 'when', 'why', 'how', 'show', 'find', 'list', 'get', 'give', 'me', 
        'us', 'tell', 'please', 'display', 'search', 'select', 'metrics', 'data', 'info', 'information', 
        'having', 'days', 'months', 'years', 'day', 'month', 'year', 'value', 'values', 'details', 'about', 
        'to', 'at', 'by', 'on', 'in', 'an', 'a', 'or', 'so', 'yet', 'nor', 'but', 'can', 'could', 'shall', 
        'should', 'will', 'would', 'may', 'might', 'must', 'has', 'have', 'had', 'doing', 'does', 'did', 'done'
    ]]
    
    candidates = []
    candidates.extend(POWER_PLANTS)
    for cat in registry.categoricals.values():
        candidates.extend([str(v) for v in cat["values"]])
    candidate_map = {c.lower(): c for c in set(candidates)}

    unhandled_entities = []
    for u in meaningful_unknowns:
        if u not in filter_values and u not in registry.metrics:
            # Direct/Substring match to a power plant
            matched_plant = None
            for p in POWER_PLANTS:
                if u == p.lower() or (len(u) >= 4 and (u in p.lower() or p.lower() in u)):
                    matched_plant = p
                    break
            
            if matched_plant:
                bp.filters.append({"column": "plant", "value": matched_plant})
                filter_values.append(matched_plant.lower())
                logger.info(f"🔮 Direct Site Recovery: mapped '{u}' -> filter 'plant' = '{matched_plant}'")
                continue
                
            # Perform Levenshtein Fuzzy Match
            found_match = None
            for c_lower, c_orig in candidate_map.items():
                dist = levenshtein_dist(u, c_lower)
                max_dist = 2 if len(u) > 4 else 1
                if dist <= max_dist:
                    found_match = c_orig
                    break
            
            if found_match:
                # Resolve target filter column name
                target_col = "plant" if found_match.lower() in [p.lower() for p in POWER_PLANTS] else None
                if not target_col:
                    for col_name, cat in registry.categoricals.items():
                        if found_match in cat["values"]:
                            target_col = "project_type" if col_name == "department" else col_name
                            break
                if target_col:
                    bp.filters.append({"column": target_col, "value": found_match})
                    filter_values.append(found_match.lower())
                    logger.info(f"🔮 Fuzzy Recovery: mapped '{u}' -> filter '{target_col}' = '{found_match}'")
                    continue
            
            unhandled_entities.append(u)

    if unhandled_entities and not ("across" in raw_query.lower() or "all sites" in raw_query.lower()):
        return {"status": "clarification_required", "message": f"Query contains unrecognized entities: {', '.join(unhandled_entities)}. Execution halted.", "results": []}

    # 1. Targeted Routing (Subset of Plants)
    target_plants = [f['value'] for f in bp.filters if f['column'] == 'plant']
    plants_to_query = [p for p in target_plants if p in POWER_PLANTS]
    if not plants_to_query:
        # Try routing by Project ID prefix
        project_id_filter = next((f['value'] for f in bp.filters if f['column'] == 'project_id'), None)
        if project_id_filter:
            match = re.match(r'^PRJ-([A-Z]{3,4})-\d+$', project_id_filter, re.I)
            if match:
                prefix = match.group(1).upper()
                prefix_map = {p[:3].upper(): p for p in POWER_PLANTS}
                target_plant = prefix_map.get(prefix)
                if target_plant:
                    plants_to_query = [target_plant]
        # Try routing by Project Name plant prefix
        if not plants_to_query:
            project_name_filter = next((f['value'] for f in bp.filters if f['column'] == 'project_name'), None)
            if project_name_filter:
                p_name_lower = project_name_filter.lower()
                for p in POWER_PLANTS:
                    p_space = p.replace('_', ' ')
                    if p_name_lower.startswith(p_space) or p_name_lower.startswith(p):
                        plants_to_query = [p]
                        break
        if not plants_to_query:
            plants_to_query = POWER_PLANTS

    where_str, metric_cols, params, sql_sel, sql_grp, sql_ord = build_federated_query_parts(bp)
    
    # Detect comparison_col
    valid_dims = list(registry.categoricals.keys())
    col_to_filters = {}
    for f in bp.filters:
        col, val = f['column'].lower(), f['value']
        target = None
        if col in valid_dims: target = col
        elif col == "project_id": target = "project_id"
        elif col == "project_name": target = "project_name"
        elif col == "department" and "project_type" in valid_dims: target = "project_type"
        elif col == "site" and "location" in valid_dims: target = "location"
        
        if target:
            if target not in col_to_filters:
                col_to_filters[target] = []
            col_to_filters[target].append(val)
            
    comparison_col = None
    for col, vals in col_to_filters.items():
        if len(vals) > 1 and col not in ['plant', 'project_id', 'project_name']:
            comparison_col = col
            break

    # 2. Detect "Comparison" intent (explicit or implicit multi-site)
    is_across_sites = ("across" in raw_query.lower() or "all sites" in raw_query.lower() or "compare" in raw_query.lower())
    is_multi_site = len(plants_to_query) > 1 and len(plants_to_query) < len(POWER_PLANTS)
    
    if comparison_col:
        force_comparison = False
    elif len(plants_to_query) == 1 and is_timeframe_range:
        force_comparison = False
    elif len(plants_to_query) > 1 and (sql_grp or is_timeframe_range):
        force_comparison = False
    else:
        force_comparison = is_across_sites or is_multi_site

    # 3. Detect Project Profile request
    project_id_filter = next((f['value'] for f in bp.filters if f['column'] == 'project_id'), None)
    project_name_filter = next((f['value'] for f in bp.filters if f['column'] == 'project_name'), None)
    is_profile_request = (project_id_filter is not None or project_name_filter is not None) and not bp.metrics
    
    # Force full row retrieval for Project Profile requests
    if is_profile_request:
        sql = f"SELECT * FROM {{table_name}} {'WHERE ' + where_str if where_str else ''} {sql_ord}".strip()
    else:
        sql = f"SELECT {sql_sel} FROM {{table_name}} {'WHERE ' + where_str if where_str else ''} {sql_grp} {sql_ord}".strip()
    
    tasks = [run_query_on_single_db(plant, sql, params) for plant in plants_to_query]
    db_results = await asyncio.gather(*tasks)

    # Inject comparison_group for multi-site comparison over time
    is_multi_site_over_time = len(plants_to_query) > 1 and (sql_grp or is_timeframe_range) and not comparison_col
    if is_multi_site_over_time:
        for plant, res_list in zip(plants_to_query, db_results):
            for row in res_list:
                row['comparison_group'] = plant.replace("_", " ").title()

    # Generate KPIs (Database Parameters)
    kpis = {}
    kpi_metrics = ['revenue', 'budget_allocated', 'budget_used', 'budget_remaining', 'capacity_mw', 'completion_percentage', 'delay_days']
    for m in kpi_metrics:
        # Only query plants that actually have this metric in their reflected schema
        valid_plants_for_metric = []
        for plant in plants_to_query:
            schema = registry.db_schemas.get(plant, {})
            # If we don't have schema info, or if the metric is in the database's schema, it's valid
            if not schema or m in schema.get("metrics", {}):
                valid_plants_for_metric.append(plant)
                
        if not valid_plants_for_metric:
            kpis[m] = 0.0
            continue
            
        op = "AVG" if m == 'completion_percentage' else "SUM"
        kpi_sql = f"SELECT {op}({m}) as {m} FROM {{table_name}} {'WHERE ' + where_str if where_str else ''}".strip()
        kpi_tasks = [run_query_on_single_db(plant, kpi_sql, params) for plant in valid_plants_for_metric]
        kpi_results = await asyncio.gather(*kpi_tasks)
        
        valid_vals = [res[0].get(m) for res in kpi_results if res and res[0].get(m) is not None]
        if not valid_vals:
            kpis[m] = 0.0
        else:
            if m == 'completion_percentage':
                kpis[m] = round(sum(valid_vals) / len(valid_vals), 2)
            else:
                kpis[m] = round(sum(valid_vals), 2)

    # Aggregation / Full Result Processing
    if is_profile_request:
        results = []
        for res in db_results: results.extend(res)
        raw_sql = interpolate_sql(sql.replace("{table_name}", "metrics_site_X"), params)
        return {
            "status": "success", 
            "results": results, 
            "sql_query": sql.replace("{table_name}", "metrics_site_X"),
            "raw_sql_query": raw_sql,
            "unit": "RawData",
            "plants_queried": len(plants_to_query),
            "kpis": kpis,
            "metadata": {"mode": "Profile", "sources": len(plants_to_query)}
        }

    metric_key = metric_cols[0]
    unit_str = determine_unit_for_metric(metric_key)
    if force_comparison:
        results = [{"label": p.replace("_", " ").title(), metric_key: round(sum([r.get(metric_key) or 0 for r in res]), 2)} 
                   for p, res in zip(plants_to_query, db_results) if sum([r.get(metric_key) or 0 for r in res]) > 0]
        raw_sql = interpolate_sql(sql.replace("{table_name}", "metrics_site_X"), params)
        return {
            "status": "success", 
            "results": results, 
            "sql_query": "Targeted Multi-Site Comparison", 
            "raw_sql_query": raw_sql,
            "unit": unit_str, 
            "plants_queried": len(plants_to_query),
            "kpis": kpis,
            "metadata": {"mode": "Site Comparison", "sources": len(plants_to_query)}
        }

    if sql_grp:
        aggregated_map = {}
        for res_list in db_results:
            for row in res_list:
                lbl = row['label']
                comp_grp = row.get('comparison_group')
                key = (lbl, comp_grp) if comp_grp is not None else lbl
                
                if key not in aggregated_map:
                    aggregated_map[key] = {m: 0.0 for m in metric_cols}
                for m in metric_cols:
                    aggregated_map[key][m] += (row.get(m) or 0.0)
                    
        results = []
        for key, ms in sorted(aggregated_map.items()):
            if isinstance(key, tuple):
                lbl, comp_grp = key
                row_data = {"label": lbl, "comparison_group": comp_grp}
            else:
                row_data = {"label": key}
            for m in metric_cols:
                row_data[m] = round(ms[m], 2)
            if any(v > 0 for v in ms.values()):
                results.append(row_data)
        
        if ("growth" in raw_query.lower() or "change" in raw_query.lower()) and len(results) > 1:
            group_prev = {}
            for row in results:
                grp = row.get('comparison_group')
                val = row[metric_key]
                if grp in group_prev:
                    prev = group_prev[grp]
                    if prev > 0: row['growth_pct'] = round(((val - prev) / prev) * 100, 2)
                    else: row['growth_pct'] = 100.0 if val > 0 else 0.0
                group_prev[grp] = val
    else:
        total = sum([res[0].get(metric_key) or 0 for res in db_results if res and res[0].get(metric_key) is not None])
        results = [{metric_key: round(total, 2)}] if total > 0 else []

    raw_sql = interpolate_sql(sql.replace("{table_name}", "metrics_site_X"), params)
    return {
        "status": "success", 
        "results": results, 
        "sql_query": sql.replace("{table_name}", "metrics_site_X"), 
        "raw_sql_query": raw_sql,
        "unit": unit_str, 
        "plants_queried": len(plants_to_query),
        "kpis": kpis,
        "metadata": {"sources": len(plants_to_query)}
    }


# --- FastAPI App ---
app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

def build_llm_system_prompt(registry, raw_query: str) -> str:
    metric_list = list(registry.metrics.keys())
    db_keys = POWER_PLANTS
    dims = {k: v["values"][:5] for k, v in registry.categoricals.items()
            if k not in ('fy_year', 'project_id')}
    temporal_cols = list(getattr(registry, "temporal_cols", {}).keys())
    return (
        "You are a universal SQL analytics assistant. "
        "Translate the user's natural language query into a strict JSON blueprint.\n\n"
        f"AVAILABLE METRICS: {metric_list}\n"
        f"AVAILABLE DATA SOURCES (databases): {db_keys}\n"
        f"AVAILABLE DIMENSIONS (with sample values): {json.dumps(dims, default=str)}\n"
        f"TEMPORAL COLUMNS: {temporal_cols}\n\n"
        "Rules:\n"
        "- Always output valid JSON with keys: operation, metrics, filters, timeframe.\n"
        "- Use only metrics and dimensions from the lists above.\n"
        "- Map data source names to the 'plant' filter column.\n"
        "- If a specific row ID is requested, set operation to 'FULL_DETAILS'.\n"
        "- Never invent column names not listed above.\n"
    )

async def call_ollama_fallback(raw_query: str) -> Blueprint:
    registry = MetadataRegistry.get_instance()
    system_prompt = build_llm_system_prompt(registry, raw_query)
    resp_text = ""
    try:
        async with httpx.AsyncClient(timeout=40.0) as client:
            resp = await client.post(OLLAMA_URL, json={"model": OLLAMA_MODEL, "prompt": raw_query, "system": system_prompt, "stream": False, "format": "json"})
            resp_text = resp.json().get('response', '').strip()
    except Exception as e:
        logger.error(f"Ollama connection error: {e}")
        return Blueprint(metrics=["revenue"])
        
    # Extract only the JSON block
    match = re.search(r'\{.*\}', resp_text, re.DOTALL)
    if match:
        resp_text = match.group(0)
        
    # Perform cleanups
    resp_text = re.sub(r',\s*null\s*', '', resp_text)
    resp_text = re.sub(r'null\s*,?\s*\]', ']', resp_text)
    resp_text = re.sub(r',\s*\]', ']', resp_text)
    resp_text = re.sub(r',\s*\}', '}', resp_text)
    
    data = None
    try:
        data = json.loads(resp_text)
    except Exception as e:
        logger.warning(f"Failed to parse cleaned LLM JSON: {e}")
        data = {}
        
    # Flatten nested dictionaries
    for nest_key in ["query", "blueprint", "response"]:
        if nest_key in data and isinstance(data[nest_key], dict):
            data.update(data[nest_key])
            
    # Reconstruct standard fields
    bp_data = {
        "operation": "SUM",
        "metrics": [],
        "filters": [],
        "timeframe": None,
        "timeframes": [],
        "is_range": False,
        "comparison": None,
        "breakdown_by": None
    }
    
    # Map operation
    op = data.get("operation") or data.get("op") or data.get("type")
    if op and isinstance(op, str):
        bp_data["operation"] = op.upper()
    else:
        for possible_op in ["FULL_DETAILS", "BREAKDOWN", "GRAPH", "TREND", "COMPARE", "SUM", "AVERAGE", "MIN", "MAX"]:
            if possible_op.lower() in raw_query.lower() or possible_op.lower() in resp_text.lower():
                bp_data["operation"] = possible_op
                break
                
    # Map metrics
    metrics_list = data.get("metrics") or data.get("metric")
    if isinstance(metrics_list, str):
        metrics_list = [metrics_list]
    if isinstance(metrics_list, list):
        for m in metrics_list:
            if m and isinstance(m, str) and m in registry.metrics:
                bp_data["metrics"].append(m)
                
    # Scan raw query for project ID pattern
    proj_id_match = re.search(r'\b(PRJ-[A-Z]+-\d+)\b', raw_query, re.I)
    if proj_id_match:
        proj_id = proj_id_match.group(1).upper()
        if not any(f["column"] == "project_id" for f in bp_data["filters"]):
            bp_data["filters"].append({"column": "project_id", "value": proj_id})

    # Scan raw query for project name pattern
    proj_name_match = re.search(r'\b(darlington|diablo[\s_]+canyon|grand[\s_]+gulf|hinkley[\s_]+point|kashiwazaki|palo[\s_]+verde|three[\s_]+mile[\s_]+island|vogtle)\s+(solar|wind|hybrid|hybrid-wind|hybrid-solar)\s+unit\s+\d+\b', raw_query, re.I)
    if proj_name_match:
        proj_name = proj_name_match.group(0)
        if not any(f["column"] == "project_name" for f in bp_data["filters"]):
            bp_data["filters"].append({"column": "project_name", "value": proj_name})

    if not bp_data["metrics"]:
        for m in registry.metrics:
            if m.lower() in raw_query.lower():
                bp_data["metrics"].append(m)
        if not bp_data["metrics"] and bp_data["operation"] != "FULL_DETAILS" and not any(f["column"] in ["project_id", "project_name"] for f in bp_data["filters"]):
            bp_data["metrics"] = ["revenue"]

    # Map filters / categoricals
    filters_list = data.get("filters")
    if isinstance(filters_list, list):
        for f in filters_list:
            if isinstance(f, dict) and "column" in f and "value" in f:
                bp_data["filters"].append(f)
                
    for plant_key in ["site", "plant", "location"]:
        plant_val = data.get(plant_key)
        if plant_val and isinstance(plant_val, str):
            for p in POWER_PLANTS:
                if p.lower() in plant_val.lower() or plant_val.lower() in p.lower():
                    if not any(f["column"] == "plant" and f["value"] == p for f in bp_data["filters"]):
                        bp_data["filters"].append({"column": "plant", "value": p})
                    break

    # Extract timeframe / year
    range_match = re.search(r'\b(20\d{2})\s*(?:-|to)\s*(20\d{2})\b', raw_query + " " + resp_text)
    year_val = data.get("year") or data.get("fy_year") or data.get("timeframe")
    if range_match:
        start_yr = range_match.group(1)
        end_yr = range_match.group(2)
        bp_data["timeframe"] = {"type": "year_range", "value": f"{start_yr}-{end_yr}"}
        bp_data["timeframes"] = [{"type": "year", "value": str(y)} for y in range(int(start_yr), int(end_yr) + 1)]
    elif year_val:
        year_str = str(year_val).replace("FY", "").strip()
        inner_range = re.match(r'^(\d{4})\s*(?:-|to)\s*(\d{4})$', year_str)
        if inner_range:
            start_yr = inner_range.group(1)
            end_yr = inner_range.group(2)
            bp_data["timeframe"] = {"type": "year_range", "value": f"{start_yr}-{end_yr}"}
            bp_data["timeframes"] = [{"type": "year", "value": str(y)} for y in range(int(start_yr), int(end_yr) + 1)]
        elif year_str.isdigit():
            bp_data["timeframe"] = {"type": "year", "value": year_str}
            bp_data["timeframes"] = [{"type": "year", "value": year_str}]
    else:
        year_match = re.search(r'\b(20\d{2})\b', raw_query + " " + resp_text)
        if year_match:
            bp_data["timeframe"] = {"type": "year", "value": year_match.group(1)}
            bp_data["timeframes"] = [{"type": "year", "value": year_match.group(1)}]

    # Map other dimensions
    for col_name, cat in registry.categoricals.items():
        val = data.get(col_name)
        if val and isinstance(val, str):
            for allowed in cat["values"]:
                if val.lower() == allowed.lower():
                    bp_data["filters"].append({"column": col_name, "value": allowed})
                    break

    return Blueprint(**bp_data)

@app.post("/api/query")
async def handle_query(payload: QueryBlueprintPayload):
    start = time.perf_counter()
    bp = payload.blueprint
    is_profile = bp and any(f.get('column') in ['project_id', 'project_name'] for f in bp.filters)
    if payload.force_llm or not bp or (not bp.metrics and not is_profile): 
        bp = await call_ollama_fallback(payload.raw_query)
    data = await federated_query_processor(bp, payload.raw_query, payload.parsing_metadata)
    data["insights"] = {"summary": "Retrieved results.", "analysis": f"Federated across {data.get('plants_queried', 0)} sites."}
    data["metadata"] = {**data.get("metadata", {}), "backend_ms": (time.perf_counter() - start) * 1000, "engine": "LLM" if payload.force_llm else "Hybrid"}
    return data

@app.get("/api/suggest")
def get_suggestions(q: str):
    registry = MetadataRegistry.get_instance()
    metrics = list(registry.metrics.keys())
    sites = POWER_PLANTS
    
    suggestions = {
        "metrics": [f"Total {m.replace('_', ' ')}" for m in metrics[:3]],
        "analysis": [f"{m.replace('_', ' ')} trend" for m in metrics[:2]],
        "comparisons": [f"Compare {sites[0]} and {sites[1]} revenue" if len(sites) > 1 else "Compare revenue across sites"]
    }
    return {"suggestions": suggestions, "preview": {"intent": "Analysis", "metric": metrics[0] if metrics else "revenue", "dimension": "Site"}}

@app.get("/api/metadata")
def get_metadata():
    registry = MetadataRegistry.get_instance()
    db_schemas = getattr(registry, "db_schemas", {})
    return {
        "metrics": list(registry.metrics.keys()),
        "databases": {
            key: {
                "tables": schema["tables"],
                "primary_table": schema["primary_table"],
                "metrics": list(schema["metrics"].keys()),
                "dimensions": list(schema["categoricals"].keys()),
                "temporal": list(schema["temporal"].keys()),
            }
            for key, schema in db_schemas.items()
        },
        "categoricals": {k: list(v["values"]) for k, v in registry.categoricals.items()},
        "plants": POWER_PLANTS,
    }

@app.get("/")
def health(): return {"status": "online"}
