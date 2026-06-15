import { useRef, useEffect, useState } from 'react';
import { DataChart } from './DataChart';

const KNOWN_METRICS = [
  'revenue',
  'profit',
  'expenses',
  'headcount',
  'salary',
  'operating_cost',
  'marketing_spend',
  'tax_liability',
  'asset_value',
  'customer_count',
  'capacity_mw',
  'completion_percentage',
  'delay_days',
  'budget_allocated',
  'budget_used',
  'budget_remaining'
];

function extractMetrics(sql: string, results: any[]): string[] {
  if (!results || results.length === 0) return ['revenue'];
  const sqlLower = (sql || '').toLowerCase();
  const foundMetrics: string[] = [];
  KNOWN_METRICS.forEach(m => {
    if (sqlLower.includes(m)) foundMetrics.push(m);
  });
  if (foundMetrics.length > 0) return foundMetrics;
  const keys = Object.keys(results[0]);
  const matchedKeys = keys.filter(k => KNOWN_METRICS.includes(k.toLowerCase()));
  return matchedKeys.length > 0 ? matchedKeys : ['revenue'];
}

const METRIC_SYNONYMS: Record<string, string[]> = {
  revenue: ['revenue', 'income', 'earnings', 'intake', 'growth'],
  profit: ['profit', 'margin', 'earnings'],
  expenses: ['expenses', 'expenditure', 'spending', 'cost', 'costs', 'expense'],
  headcount: ['headcount', 'staff', 'employees'],
  budget_allocated: ['budget_allocated', 'budget allocated', 'allocated budget', 'allocated'],
  budget_used: ['budget_used', 'budget used', 'used budget', 'used'],
  budget_remaining: ['budget_remaining', 'budget remaining', 'remaining budget', 'remaining'],
  capacity_mw: ['capacity_mw', 'capacity', 'mw'],
  completion_percentage: ['completion_percentage', 'completion', 'percentage', '%'],
  delay_days: ['delay_days', 'delay', 'days']
};

interface ResultsDisplayProps {
  data: any;
  devMode: boolean;
  onFollowUpClick: (query: string) => void;
  darkMode?: boolean;
  query?: string;
  /** When true the live KPI strip in page.tsx is already rendering the KPI cards above; suppress the internal bar to avoid duplication */
  hideKpiBar?: boolean;
}

export function ResultsDisplay({ data, devMode, onFollowUpClick, darkMode, query, hideKpiBar = false }: ResultsDisplayProps) {
  const summaryRef = useRef<HTMLDivElement>(null);
  const [activeMetadata, setActiveMetadata] = useState<any>(null);

  useEffect(() => {
    fetch('/api/metadata').then(r => r.json()).then(setActiveMetadata).catch(() => {});
  }, []);

  if (!data || !data.results) return null;

  const { results, sql_query, raw_sql_query, unit, plants_queried, insights, metadata, kpis } = data;

  const formatKPI = (val: any, metric?: string) => {
    if (val == null) return "0";
    const metricLower = (metric || '').toLowerCase();
    const isCurrency = !['headcount', 'customer_count', 'completion_percentage', 'delay_days', 'capacity_mw'].includes(metricLower);
    const prefix = isCurrency ? "₹" : "";
    let suffix = isCurrency ? " Cr" : "";
    
    if (metricLower === 'completion_percentage') suffix = "%";
    if (metricLower === 'delay_days') suffix = " Days";
    if (metricLower === 'capacity_mw') suffix = " MW";
    
    if (val >= 1000000) return `${prefix}${(val / 1000000).toFixed(1)}M${suffix}`;
    if (val >= 1000) return `${prefix}${(val / 1000).toFixed(1)}K${suffix}`;
    return `${prefix}${val.toLocaleString()}${suffix}`;
  };

  const getFollowUpQuestions = () => {
    const detectedMetrics = extractMetrics(sql_query, results);
    const m = detectedMetrics[0] || "revenue";
    const capM = m.replace(/_/g, ' ').charAt(0).toUpperCase() + m.replace(/_/g, ' ').slice(1);
    
    const sqlLower = (sql_query || '').toLowerCase();
    const depts = activeMetadata?.categoricals?.project_type || ["solar", "wind", "hybrid"];
    const plants = activeMetadata?.plants || ["diablo_canyon", "grand_gulf"];
    
    const activeDept = depts.find((d: string) => sqlLower.includes(`'${d.toLowerCase()}'`));
    const activePlant = plants.find((p: string) => sqlLower.includes(p.toLowerCase()));
    
    const questions = [];
    if (activeDept) {
      questions.push(`${activeDept} ${capM} Trend`);
      questions.push(`Compare ${activeDept} and Wind ${capM}`);
      questions.push(`${activeDept} ${capM} by Site`);
    } else if (activePlant) {
      questions.push(`${capM} Trend in ${activePlant}`);
      questions.push(`Compare ${activePlant} and Darlington`);
      questions.push(`${activePlant} Breakdown by Project Type`);
    } else {
      questions.push(`Total ${capM} Across All Sites`);
      questions.push(`${capM} Trend 2024-2027`);
      questions.push(`Breakdown of ${capM} by Project Type`);
    }
    return questions.slice(0, 5);
  };

  const displayKpis: Record<string, any> = {
    revenue: kpis?.revenue ?? 0,
    profit: kpis?.profit ?? 0,
    expenses: kpis?.expenses ?? 0,
    headcount: kpis?.headcount ?? 0,
    budget_allocated: kpis?.budget_allocated ?? 0,
    budget_used: kpis?.budget_used ?? 0,
    budget_remaining: kpis?.budget_remaining ?? 0,
    capacity_mw: kpis?.capacity_mw ?? 0,
    completion_percentage: kpis?.completion_percentage ?? 0,
    delay_days: kpis?.delay_days ?? 0
  };

  const activeKpis = Object.entries(displayKpis).filter(([name]) => {
    // Check if name is explicitly referenced in the SQL query
    const sqlLower = (sql_query || '').toLowerCase();
    if (sqlLower.includes(name.toLowerCase())) return true;

    // Check if any synonym matches the raw query string
    if (query) {
      const qLower = query.toLowerCase();
      const synonyms = METRIC_SYNONYMS[name] || [name];
      if (synonyms.some(syn => qLower.includes(syn))) {
        return true;
      }
    }
    return false;
  }).map(([name, val]) => ({ name, val }));

  const gridCols = activeKpis.length === 1 ? 'grid-cols-1 max-w-sm' :
                   activeKpis.length === 2 ? 'grid-cols-2 max-w-2xl' :
                   activeKpis.length === 3 ? 'grid-cols-3' : 'grid-cols-4';

  return (
    <div className="p-6 space-y-6">
      {/* 1. Contextual KPIs Bar — hidden when the live strip above is already showing them */}
      {!hideKpiBar && activeKpis.length > 0 && (
        <div className={`grid gap-6 ${gridCols}`}>
          {activeKpis.map(({ name, val }) => (
            <div key={name} className="bg-white dark:bg-slate-900 border border-gray-100 dark:border-slate-800 shadow-sm rounded-2xl p-5 transition-all hover:shadow-md">
              <p className="text-[10px] font-bold text-gray-400 dark:text-slate-500 uppercase tracking-wider mb-2">{name.replace(/_/g, ' ')}</p>
              <p className="text-2xl font-extrabold text-gray-900 dark:text-slate-50 tracking-tight">{formatKPI(val, name)}</p>
            </div>
          ))}
        </div>
      )}

      {/* 2. Main Visualization */}
      <div className="bg-white dark:bg-slate-900 border border-gray-100 dark:border-slate-800 shadow-xl rounded-3xl p-6">
        <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-4">Analytical Visualization</h3>
        <div className="flex items-center justify-center min-h-[400px]">
          <DataChart results={results} unit={unit} darkMode={darkMode} />
        </div>
      </div>

      {/* 3. Narrative & Table */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white dark:bg-slate-900 border border-gray-100 dark:border-slate-800 shadow-sm rounded-2xl p-6 md:col-span-1">
          <h3 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">AI Narrative</h3>
          <div className="bg-indigo-50/30 dark:bg-indigo-950/20 border border-indigo-100/50 dark:border-indigo-900/30 rounded-2xl p-5 text-sm leading-relaxed text-slate-700 dark:text-slate-300 font-medium">
            {insights?.summary || "No automated summary available for this dataset."}
            <div className="mt-4 pt-4 border-t border-indigo-100/30 text-xs italic opacity-70">{insights?.analysis}</div>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-gray-100 dark:border-slate-800 shadow-sm rounded-2xl p-6 md:col-span-2">
          <h3 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">Raw Data Ledger</h3>
          <div className="overflow-auto rounded-xl border border-gray-100 dark:border-slate-800 max-h-64">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-50 dark:bg-slate-850 sticky top-0 font-bold">
                <tr>
                  {Object.keys(results[0] || {}).map((key) => (
                    <th key={key} className="py-3 px-4 text-gray-500 dark:text-slate-400 font-bold uppercase tracking-wider text-[9px]">{key.replace(/_/g, ' ')}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                {results.map((row: any, idx: number) => (
                  <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                    {Object.values(row).map((value: any, cIdx: number) => (
                      <td key={cIdx} className="py-3 px-4 text-gray-900 dark:text-slate-200 font-medium">
                        {typeof value === 'number' ? (
                          value.toLocaleString()
                        ) : typeof value === 'string' && (/^PRJ-[A-Z]+-\d+$/i.test(value) || /^(darlington|diablo[\s_]+canyon|grand[\s_]+gulf|hinkley[\s_]+point|kashiwazaki|palo[\s_]+verde|three[\s_]+mile[\s_]+island|vogtle)[\s_]+(solar|wind|hybrid|hybrid-wind|hybrid-solar)[\s_]+unit[\s_]+\d+$/i.test(value)) ? (
                          <button
                            onClick={() => onFollowUpClick(value)}
                            className="text-indigo-650 dark:text-indigo-400 font-bold hover:underline cursor-pointer"
                          >
                            {value}
                          </button>
                        ) : (
                          String(value)
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* 4. Follow-ups */}
      <div className="pt-4">
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-3">Recommended Actions</p>
          <div className="flex flex-wrap gap-2">
              {getFollowUpQuestions().map((q, i) => (
                  <button key={i} onClick={() => onFollowUpClick(q)} className="px-4 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl text-xs font-bold text-indigo-600 hover:bg-indigo-50 transition-all shadow-sm">
                      {q} ⚡
                  </button>
              ))}
          </div>
      </div>

      {/* 5. Dev Mode */}
      {devMode && (
        <div className="mt-8 p-6 bg-slate-900 rounded-3xl text-indigo-300 font-mono text-[10px] overflow-hidden shadow-2xl border border-indigo-500/20">
          <div className="flex items-center justify-between mb-4 border-b border-indigo-500/10 pb-4">
              <span className="text-indigo-400 font-black uppercase tracking-widest">System Pipeline Trace</span>
              <span className="px-2 py-0.5 bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 text-[8px] font-bold rounded-full uppercase tracking-wider">v2.1 Trace Active</span>
          </div>
          <div className="grid grid-cols-2 gap-8">
              <div>
                  <p className="text-white/40 mb-2 uppercase font-black text-[8px]">Execution Blueprint</p>
                  <pre className="p-4 bg-black/40 rounded-2xl border border-white/5 overflow-auto max-h-48">{JSON.stringify(metadata, null, 2)}</pre>
              </div>
              <div>
                  <p className="text-white/40 mb-2 uppercase font-black text-[8px]">SQL Template</p>
                  <pre className="p-4 bg-black/40 rounded-2xl border border-white/5 overflow-auto max-h-24 text-indigo-400/80 whitespace-pre-wrap mb-4">{sql_query}</pre>
                  <p className="text-white/40 mb-2 uppercase font-black text-[8px]">Raw SQL Query</p>
                  <pre className="p-4 bg-black/40 rounded-2xl border border-white/5 overflow-auto max-h-32 text-emerald-400 whitespace-pre-wrap">{raw_sql_query || sql_query}</pre>
              </div>
          </div>
        </div>
      )}
    </div>
  );
}
