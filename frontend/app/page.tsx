'use client';

import { useState, useEffect, useRef } from 'react';
import { QueryInterface } from '@/components/QueryInterface';
import { ResultsDisplay } from '@/components/ResultsDisplay';
import { getTokens, buildBlueprint, ClassifiedToken, QueryBlueprint, globalTrie } from './engine';

// ─── KPI metric keys the backend actually computes ───────────────────────────
const KPI_METRIC_KEYS = [
  'revenue', 'profit', 'expenses', 'headcount',
  'budget_allocated', 'budget_used', 'budget_remaining',
  'capacity_mw', 'completion_percentage', 'delay_days',
] as const;
type KpiKey = typeof KPI_METRIC_KEYS[number];

function formatKpiValue(val: number | null | undefined, metric: string): string {
  if (val == null) return '0';
  const m = metric.toLowerCase();
  const isCurrency = !['headcount', 'customer_count', 'completion_percentage', 'delay_days', 'capacity_mw'].includes(m);
  const prefix = isCurrency ? '\u20b9' : '';
  let suffix = isCurrency ? ' Cr' : '';
  if (m === 'completion_percentage') suffix = '%';
  if (m === 'delay_days') suffix = ' Days';
  if (m === 'capacity_mw') suffix = ' MW';
  if (val >= 1_000_000) return `${prefix}${(val / 1_000_000).toFixed(1)}M${suffix}`;
  if (val >= 1_000)     return `${prefix}${(val / 1_000).toFixed(1)}K${suffix}`;
  return `${prefix}${val.toLocaleString()}${suffix}`;
}

// ─── Persistent live KPI placeholder strip ───────────────────────────────────
function LiveKpiStrip({
  metrics,
  kpis,
  isLoading,
  darkMode,
}: {
  metrics: string[];
  kpis: Record<string, number> | null;
  isLoading: boolean;
  darkMode: boolean;
}) {
  const valid = metrics.filter((m): m is KpiKey => KPI_METRIC_KEYS.includes(m as KpiKey));
  if (valid.length === 0) return null;

  const gridClass =
    valid.length === 1 ? 'grid-cols-1 max-w-xs' :
    valid.length === 2 ? 'grid-cols-2' :
    valid.length === 3 ? 'grid-cols-3' : 'grid-cols-4';

  // kpis object present + not loading means a completed result is available
  const hasResults = !isLoading && kpis !== null;

  return (
    <div className={`grid gap-4 ${gridClass} px-6 pt-6 pb-2 flex-shrink-0`}>
      {valid.map((metric, idx) => {
        const val = kpis?.[metric];
        const formatted = (hasResults && val != null) ? formatKpiValue(val, metric) : null;
        return (
          <div
            key={metric}
            className="kpi-card-mount bg-white dark:bg-slate-900 border border-gray-100 dark:border-slate-800 shadow-sm rounded-2xl p-5 hover:shadow-md transition-shadow"
            style={{ animationDelay: `${idx * 55}ms`, animationFillMode: 'both' }}
          >
            <p className="text-[10px] font-bold text-gray-400 dark:text-slate-500 uppercase tracking-wider mb-2">
              {metric.replace(/_/g, ' ')}
            </p>

            {formatted !== null ? (
              /* Value slides up once results arrive — key change forces re-animation */
              <p
                key={`${metric}-${formatted}`}
                className="kpi-value-reveal text-2xl font-extrabold text-gray-900 dark:text-slate-50 tracking-tight"
              >
                {formatted}
              </p>
            ) : (
              /* Pulsing skeleton — shown while typing or while backend is loading */
              <div className="mt-1 flex flex-col gap-1.5">
                <div className="h-7 w-28 bg-gray-100 dark:bg-slate-800 rounded-lg animate-pulse" />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const parseErrorMessage = (msg: string) => {
  let mainMsg = msg;
  let suggestion: string | null = null;
  let suggestionType: 'did-you-mean' | 'try-searching' = 'did-you-mean';

  const didYouMeanIndex = msg.indexOf("Did you mean: ");
  const trySearchingIndex = msg.indexOf("Try searching for: ");

  if (didYouMeanIndex !== -1) {
    mainMsg = msg.substring(0, didYouMeanIndex).trim();
    const rawSuggestion = msg.substring(didYouMeanIndex + "Did you mean: ".length).trim();
    suggestion = rawSuggestion.replace(/^['"]|['"]\??$/g, '').trim();
    suggestionType = 'did-you-mean';
  } else if (trySearchingIndex !== -1) {
    mainMsg = msg.substring(0, trySearchingIndex).trim();
    const rawSuggestion = msg.substring(trySearchingIndex + "Try searching for: ".length).trim();
    suggestion = rawSuggestion;
    suggestionType = 'try-searching';
  }

  return { mainMsg, suggestion, suggestionType };
};

const parseTrySearchingList = (sug: string) => {
  return sug.split(',').map(item => {
    let cleaned = item.trim().replace(/^['"]|['"]\??$/g, '');
    if (cleaned.startsWith("or ")) {
      cleaned = cleaned.substring(3).trim();
    }
    if (cleaned.endsWith('.')) {
      cleaned = cleaned.slice(0, -1);
    }
    return cleaned.replace(/^['"]|['"]$/g, '').trim();
  }).filter(x => x.length > 0);
};

export default function Home() {
  const [results, setResults] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recentQueries, setRecentQueries] = useState<{query: string, result: any}[]>([]);
  const [devMode, setDevMode] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [executionLatency, setExecutionLatency] = useState<number | null>(null);
  const [llmOnlyMode, setLlmOnlyMode] = useState(false);

  // Live KPIs populated once results arrive
  const [liveKpis, setLiveKpis] = useState<{
    revenue?: number; budget_allocated?: number; budget_used?: number; budget_remaining?: number;
    capacity_mw?: number; completion_percentage?: number; delay_days?: number;
  } | null>(null);
  const [liveQuery, setLiveQuery] = useState('');
  // Metrics detected client-side as user types — drives placeholder KPI cards immediately
  const [detectedMetrics, setDetectedMetrics] = useState<string[]>([]);
  const liveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Live execution timer — counts up while isLoading, freezes at final value when done
  const [timerMs, setTimerMs] = useState<number | null>(null);
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerStartRef = useRef<number>(0);

  useEffect(() => {
    if (llmOnlyMode && liveDebounceRef.current) {
      clearTimeout(liveDebounceRef.current);
      liveDebounceRef.current = null;
    }
  }, [llmOnlyMode]);

  // Start / stop the live timer in sync with query execution
  useEffect(() => {
    if (isLoading) {
      timerStartRef.current = performance.now();
      setTimerMs(0);
      timerIntervalRef.current = setInterval(() => {
        setTimerMs(Math.floor(performance.now() - timerStartRef.current));
      }, 33); // ~30 fps — smooth but cheap
    } else {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
      // Freeze at the backend-reported latency when available, else keep last tick
      if (executionLatency != null) {
        setTimerMs(Math.round(executionLatency));
      }
    }
    return () => {
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    };
  }, [isLoading]);
 

  // Load recents and sync metadata
  useEffect(() => {
    const saved = localStorage.getItem('alphabot_recents');
    if (saved) {
      try { setRecentQueries(JSON.parse(saved)); } catch {}
    }

    const fetchMetadata = async () => {
        let retries = 5;
        let response = null;
        for (let i = 0; i < retries; i++) {
            try {
                response = await fetch('http://127.0.0.1:8000/api/metadata');
                if (response.ok) break;
            } catch (err) {
                if (i === retries - 1) console.error("❌ Metadata fetch error:", err);
            }
            await new Promise(r => setTimeout(r, 2000));
        }
        if (!response || !response.ok) {
            console.error("❌ Metadata sync failed: response not ok");
            return;
        }
        try {
          const data = await response.json();
          
          if (data.metrics) {
              data.metrics.forEach((m: string) => {
                  globalTrie.insert(m, 'METRIC');
                  globalTrie.insert(m.replace(/_/g, ' '), 'METRIC', { canonical: m });
              });
          }
          
          if (data.categoricals) {
              Object.entries(data.categoricals).forEach(([col, values]: [string, any]) => {
                  values.forEach((val: string) => {
                      globalTrie.insert(val, 'DIMENSION', { column: col });
                  });
              });
          }
          
          if (data.plants) {
              data.plants.forEach((p: string) => {
                  globalTrie.insert(p, 'DIMENSION', { column: 'plant' });
                  globalTrie.insert(p.replace(/_/g, ' '), 'DIMENSION', { column: 'plant' });
              });
          }
        } catch (err) {
          console.error("❌ Metadata sync failed:", err);
        }
      };
      fetchMetadata();
  }, []);

  // Whenever the result changes, sync KPIs from the latest full result
  useEffect(() => {
    if (results?.kpis) setLiveKpis(results.kpis);
  }, [results]);

  // Live Search: debounced 500ms for analysis
  const handleLiveTyping = (q: string) => {
    setLiveQuery(q);
    setError(null);
    if (liveDebounceRef.current) clearTimeout(liveDebounceRef.current);
    if (recentTimerRef.current) {
      clearTimeout(recentTimerRef.current);
      recentTimerRef.current = null;
    }
    
    const trimmed = q.trim();
    if (!trimmed) {
      setResults(null);
      setLiveKpis(null);
      setDetectedMetrics([]);
      return;
    }

    // Detect metrics instantly (Trie lookup, ~0ms) so placeholder cards appear while typing
    if (!llmOnlyMode) {
      const bp = buildBlueprint(trimmed);
      const found = bp.blueprint.metrics.filter(m =>
        KPI_METRIC_KEYS.includes(m as KpiKey)
      );
      setDetectedMetrics(found);
    }

    if (llmOnlyMode) {
      return;
    }
    
    liveDebounceRef.current = setTimeout(async () => {
      handleQuery(trimmed);
    }, 500);
  };

  const handleQuery = async (query: string) => {
    setLiveQuery(query);
    if (liveDebounceRef.current) {
      clearTimeout(liveDebounceRef.current);
      liveDebounceRef.current = null;
    }
    setIsLoading(true);
    setError(null);
    const startTimer = performance.now();

    // 1. Generate Hybrid Blueprint locally
    const blueprint = buildBlueprint(query);

    try {
      const response = await fetch('http://127.0.0.1:8000/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            raw_query: query, 
            blueprint: blueprint.blueprint,
            parsing_metadata: blueprint.parsing_metadata,
            force_llm: llmOnlyMode || blueprint.parsing_metadata.fallback_required
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.detail || 'Query failed');
      }

      const data = await response.json();
      setExecutionLatency(performance.now() - startTimer);

      if (data.status === 'clarification_required') {
          setError(data.message);
          setResults(null);
      } else {
          setResults(data);
          if (data.kpis) setLiveKpis(data.kpis);

          // Save to recent queries after 5 seconds on screen
          if (recentTimerRef.current) {
            clearTimeout(recentTimerRef.current);
          }
          recentTimerRef.current = setTimeout(() => {
            setRecentQueries(prev => {
              const filtered = prev.filter(item => item.query.toLowerCase() !== query.toLowerCase());
              const updated = [{ query, result: data }, ...filtered].slice(0, 10);
              localStorage.setItem('alphabot_recents', JSON.stringify(updated));
              return updated;
            });
          }, 5000);
      }

    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      setExecutionLatency(null);
    } finally {
      setIsLoading(false);
    }
  };

  const loadRecent = (item: {query: string, result: any}) => {
    setLiveQuery(item.query);
    setResults(item.result);
    if (item.result?.kpis) setLiveKpis(item.result.kpis);
    setError(null);
    setExecutionLatency(item.result?.metadata?.backend_ms || null);
  };

  return (
    <div className={darkMode ? 'dark' : ''}>
      <div className="h-screen flex bg-gray-50 dark:bg-slate-950 overflow-hidden text-slate-800 dark:text-slate-100 transition-colors duration-200">

        {/* Thin icon sidebar */}
        <aside className="w-[72px] bg-white dark:bg-slate-900 border-r border-gray-200 dark:border-slate-800 flex flex-col items-center py-4 flex-shrink-0 z-20 shadow-sm transition-colors duration-200">
          <div className="w-10 h-10 mb-8 flex items-center justify-center">
            <svg viewBox="0 0 40 40" className="w-8 h-8" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M20 5L10 30h5l2.5-6.25h5L25 30h5L20 5z" fill="#4F46E5"/>
              <path d="M15 25L20 12.5 25 25h-10z" fill="#10B981" opacity="0.8"/>
            </svg>
          </div>

          <div className="flex-1 flex flex-col items-center gap-6 w-full">
            <button className="w-10 h-10 bg-blue-100 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 rounded-lg flex items-center justify-center">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
                <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
              </svg>
            </button>
          </div>

          <div className="flex flex-col items-center gap-4 w-full mt-auto">
            <button 
              onClick={() => setDarkMode(!darkMode)}
              className="w-10 h-10 text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-850 rounded-lg flex items-center justify-center transition-colors"
            >
              {darkMode ? (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707m12.728 0l-.707-.707M6.343 6.343l-.707-.707M12 5a7 7 0 100 14 7 7 0 000-14z"/>
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/>
                </svg>
              )}
            </button>
            <div className="w-8 h-8 rounded-full bg-indigo-600 text-white flex items-center justify-center font-bold text-xs shadow-lg shadow-indigo-200">A</div>
          </div>
        </aside>

        {/* Main Container */}
        <div className="flex-1 flex flex-col min-w-0">

          {/* Header */}
          <header className="bg-white dark:bg-slate-900 border-b border-gray-200 dark:border-slate-800 px-6 py-4 flex-shrink-0 z-10 flex items-center justify-between gap-4 transition-colors duration-200">
            <div className="flex items-center gap-4">
              <h1 className="text-xl font-bold text-gray-900 dark:text-slate-50 tracking-tight">Alphabot Enterprise</h1>
              <div className="px-3 py-1 bg-green-50 dark:bg-green-950/20 border border-green-100 dark:border-green-900/30 rounded-full flex items-center gap-2">
                <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"/>
                <span className="text-xs font-semibold text-green-700 dark:text-green-400">Systems Operational</span>
              </div>
            </div>

            <div className="flex items-center gap-6">
              {/* Live execution timer — visible once a query has started */}
              {timerMs !== null && (
                <div className="flex items-center gap-2 border-r border-slate-200 dark:border-slate-800 pr-6 mr-6">
                  <div className="flex items-center gap-1.5">
                    {isLoading ? (
                      <span className="w-1.5 h-1.5 rounded-full bg-orange-400 animate-ping" />
                    ) : (
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    )}
                    <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500">
                      {isLoading ? 'Running' : 'Completed'}
                    </span>
                  </div>
                  <span
                    className={`text-sm font-mono font-bold tabular-nums transition-colors duration-300 ${
                      isLoading
                        ? 'text-orange-500 dark:text-orange-400'
                        : 'text-emerald-600 dark:text-emerald-400'
                    }`}
                  >
                    {(timerMs / 1000).toFixed(2)}s
                  </span>
                </div>
              )}
              {/* LLM Mode Toggle */}
              <div className="flex items-center gap-2.5">
                <span className="text-xs font-bold text-gray-400 dark:text-slate-500 uppercase tracking-wider">LLM Mode</span>
                <button
                  onClick={() => setLlmOnlyMode(!llmOnlyMode)}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${llmOnlyMode ? 'bg-indigo-600' : 'bg-gray-200 dark:bg-slate-800'}`}
                  title="Force execution through local LLM only (no fast-path/live debouncing)"
                >
                  <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${llmOnlyMode ? 'translate-x-5' : 'translate-x-0'}`}/>
                </button>
              </div>

              {/* Dev Mode Toggle */}
              <div className="flex items-center gap-2.5">
                <span className="text-xs font-bold text-gray-400 dark:text-slate-500 uppercase tracking-wider">Dev Mode</span>
                <button
                  onClick={() => setDevMode(!devMode)}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${devMode ? 'bg-indigo-600' : 'bg-gray-200 dark:bg-slate-800'}`}
                >
                  <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${devMode ? 'translate-x-5' : 'translate-x-0'}`}/>
                </button>
              </div>
            </div>
          </header>

          {/* Main Content */}
          <main className="flex-1 flex overflow-hidden">

            {/* Left panel — Query interface */}
            <div className="w-[380px] bg-white dark:bg-slate-900 border-r border-gray-200 dark:border-slate-800 flex flex-col flex-shrink-0 shadow-[2px_0_8px_-4px_rgba(0,0,0,0.05)] z-0 transition-colors duration-200">
              <div className="flex-1 overflow-y-auto p-6">
                <h2 className="text-sm font-semibold text-gray-900 dark:text-slate-100 mb-4">Ask a Question</h2>
                <QueryInterface
                  onSubmit={handleQuery}
                  isLoading={isLoading}
                  recentQueries={recentQueries}
                  onSelectRecent={loadRecent}
                  liveKpis={liveKpis}
                  onQueryChange={handleLiveTyping}
                  results={results}
                  query={liveQuery}
                />
              </div>
            </div>

            {/* Right panel — Results & Errors */}
            <div className="flex-1 flex flex-col bg-gray-50/50 dark:bg-slate-950/40 transition-colors duration-200 overflow-hidden">

              {/* ── Persistent live KPI strip — appears the moment a metric keyword is typed ── */}
              {detectedMetrics.length > 0 && (
                <LiveKpiStrip
                  metrics={detectedMetrics}
                  kpis={liveKpis as Record<string, number> | null}
                  isLoading={isLoading}
                  darkMode={darkMode}
                />
              )}

              <div className="flex-1 overflow-y-auto">
                {isLoading ? (
                  <div className={detectedMetrics.length > 0 ? 'flex items-center justify-center py-16' : 'h-full flex items-center justify-center'}>
                    <div className="text-center">
                      <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-500 dark:border-indigo-400 mx-auto mb-4"/>
                      <p className="text-sm font-semibold text-gray-600 dark:text-slate-400">Federated Analysis in Progress…</p>
                    </div>
                  </div>
                ) : error ? (
                  <div className="flex items-center justify-center p-8 bg-gray-50/50 dark:bg-slate-950/20">
                    <div className="max-w-md w-full bg-white dark:bg-slate-900 border border-red-200 dark:border-red-950/80 shadow-lg rounded-3xl p-6 text-center">
                      <div className="w-12 h-12 bg-red-50 dark:bg-red-950/30 border border-red-100 dark:border-red-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
                        <span className="text-red-600 dark:text-red-400 text-lg font-bold">⚠</span>
                      </div>
                      <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100 mb-2">Analysis Interrupted</h3>
                      {(() => {
                        const { mainMsg, suggestion, suggestionType } = parseErrorMessage(error);
                        return (
                          <>
                            <p className="text-xs text-red-600 dark:text-red-400 font-semibold leading-relaxed mb-4">{mainMsg}</p>
                            {suggestion && (
                              suggestionType === 'did-you-mean' ? (
                                <div 
                                  onClick={() => { handleQuery(suggestion); }}
                                  className="mt-4 p-4 bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-900/30 rounded-2xl text-center shadow-sm cursor-pointer hover:bg-indigo-100 dark:hover:bg-indigo-900/60 transition-all group border-dashed"
                                >
                                  <p className="text-[10px] font-bold text-indigo-600 dark:text-indigo-400 uppercase tracking-widest mb-1.5">Suggested Query</p>
                                  <p className="text-sm font-semibold text-indigo-800 dark:text-indigo-200 group-hover:underline">“{suggestion}”</p>
                                  <p className="text-[10px] text-indigo-500 dark:text-indigo-450 mt-2 font-medium">Click to run this query instantly ⚡</p>
                                </div>
                              ) : (
                                <div className="mt-4 text-center">
                                  <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2.5">Try searching for</p>
                                  <div className="flex flex-col gap-2">
                                    {parseTrySearchingList(suggestion).map(item => (
                                      <button
                                        key={item}
                                        type="button"
                                        onClick={() => { handleQuery(item); }}
                                        className="px-4 py-2 text-xs font-semibold bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-700 dark:text-slate-200 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 hover:text-indigo-600 dark:hover:text-indigo-400 hover:border-indigo-200 dark:hover:border-indigo-900 transition-all cursor-pointer shadow-sm text-center"
                                      >
                                        {item}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              )
                            )}
                          </>
                        );
                      })()}
                    </div>
                  </div>
                ) : results ? (
                  <ResultsDisplay 
                    data={results} 
                    devMode={devMode} 
                    onFollowUpClick={handleQuery} 
                    darkMode={darkMode} 
                    query={liveQuery}
                    hideKpiBar={detectedMetrics.length > 0}
                  />
                ) : (
                  detectedMetrics.length === 0 && (
                    <div className="h-full flex items-center justify-center">
                      <div className="text-center max-w-md px-6">
                        <div className="w-20 h-20 bg-white dark:bg-slate-900 shadow-xl border border-gray-100 dark:border-slate-800 rounded-3xl flex items-center justify-center mx-auto mb-8 transform -rotate-6">
                          <svg className="w-10 h-10 text-indigo-500 dark:text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>
                          </svg>
                        </div>
                        <h3 className="text-2xl font-bold text-gray-900 dark:text-slate-50 mb-3 tracking-tight">Intelligence Ready</h3>
                        <p className="text-slate-500 dark:text-slate-400 font-medium max-w-xs mx-auto leading-relaxed">
                          Ask any question about plant performance, revenue trends, or project metrics.
                        </p>
                        <div className="mt-8 flex flex-wrap justify-center gap-2">
                           <span className="px-3 py-1 bg-slate-100 dark:bg-slate-800 rounded-lg text-[10px] font-bold text-slate-500 uppercase tracking-wider">Federated Engine</span>
                           <span className="px-3 py-1 bg-slate-100 dark:bg-slate-800 rounded-lg text-[10px] font-bold text-slate-500 uppercase tracking-wider">Hybrid Parsing</span>
                           <span className="px-3 py-1 bg-slate-100 dark:bg-slate-800 rounded-lg text-[10px] font-bold text-slate-500 uppercase tracking-wider">Zero-Trust Guard</span>
                        </div>
                      </div>
                    </div>
                  )
                )}
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
