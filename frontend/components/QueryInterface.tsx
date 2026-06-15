import { useState, useRef, useEffect, useCallback } from 'react';
import { getTokens, ClassifiedToken } from '../app/engine';

interface QueryInterfaceProps {
  onSubmit: (query: string) => void;
  isLoading: boolean;
  recentQueries?: {query: string, result: any}[];
  onSelectRecent?: (item: {query: string, result: any}) => void;
  liveKpis?: {
    revenue?: number; budget_allocated?: number; budget_used?: number; budget_remaining?: number;
    capacity_mw?: number; completion_percentage?: number; delay_days?: number;
  } | null;
  onQueryChange?: (q: string) => void;
  results?: any;
  query?: string;
}

interface CategorizedSuggestions {
  metrics: string[];
  analysis: string[];
  comparisons: string[];
}

interface Preview {
  intent: string;
  metric: string;
  dimension: string;
}

const ORDERED_CATEGORIES = [
  'project_id',
  'project_name',
  'contractor_payment_status',
  'project_type',
  'location',
  'state',
  'fy_year',
  'category',
  'contractor_name',
  'material_status'
];

const KNOWN_METRICS = [
  'revenue', 'profit', 'expenses', 'headcount', 'salary', 'operating_cost', 
  'marketing_spend', 'tax_liability', 'asset_value', 'customer_count', 
  'capacity_mw', 'completion_percentage', 'delay_days', 'budget_allocated',
  'budget_used', 'budget_remaining'
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

export function QueryInterface({ onSubmit, isLoading, recentQueries, onSelectRecent, liveKpis, onQueryChange, results, query: parentQuery }: QueryInterfaceProps) {
  const [query, setQuery] = useState(parentQuery || '');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [categorizedSuggestions, setCategorizedSuggestions] = useState<CategorizedSuggestions>({
    metrics: [], analysis: [], comparisons: []
  });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [lastSubmitted, setLastSubmitted] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [classifiedTokens, setClassifiedTokens] = useState<ClassifiedToken[]>([]);

  useEffect(() => {
    if (parentQuery !== undefined && parentQuery !== query) {
      setQuery(parentQuery);
    }
  }, [parentQuery]);

  const [metrics, setMetrics] = useState<string[]>([]);
  const [categoricals, setCategoricals] = useState<Record<string, string[]>>({});
  const [plants, setPlants] = useState<string[]>([]);

  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionListRef = useRef<HTMLDivElement>(null);
  const tagsRef = useRef<HTMLDivElement>(null);

  const scrollToTags = () => {
    tagsRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    const loadMetadata = async () => {
      let response = null;
      for (let i = 0; i < 5; i++) {
        try {
          response = await fetch('http://127.0.0.1:8000/api/metadata');
          if (response.ok) break;
        } catch (err) {
          // ignore and retry
        }
        await new Promise(r => setTimeout(r, 2000));
      }
      if (response && response.ok) {
        try {
          const data = await response.json();
          if (data.metrics) setMetrics(data.metrics.map((x: string) => x.replace(/_/g, ' ')));
          if (data.categoricals) setCategoricals(data.categoricals);
          if (data.plants) setPlants(data.plants);
        } catch (e) {}
      }
    };
    loadMetadata();
  }, []);

  const getFollowUpQuestions = () => {
    if (!results || !results.results) return [];
    const detectedMetrics = extractMetrics(results.sql_query, results.results);
    const m = detectedMetrics[0] || "revenue";
    const capM = m.replace(/_/g, ' ').charAt(0).toUpperCase() + m.replace(/_/g, ' ').slice(1);
    
    const sqlLower = (results.sql_query || '').toLowerCase();
    const activeDept = categoricals.project_type?.find(d => sqlLower.includes(d.toLowerCase()));
    const activePlant = plants.find(p => sqlLower.includes(p.toLowerCase()));
    
    const questions = [];
    if (activeDept) {
      questions.push(`${activeDept} ${capM} Trend`);
      questions.push(`Compare ${activeDept} and Wind ${capM}`);
      questions.push(`${activeDept} ${capM} by Site`);
    } else if (activePlant) {
      const pLabel = activePlant.replace(/_/g, ' ').toUpperCase();
      questions.push(`${capM} Trend in ${pLabel}`);
      questions.push(`Compare ${pLabel} and Darlington`);
      questions.push(`${pLabel} Breakdown by Project Type`);
    } else {
      questions.push(`Total ${capM} Across All Sites`);
      questions.push(`${capM} Trend 2024-2027`);
      questions.push(`Breakdown of ${capM} by Project Type`);
    }
    return questions.slice(0, 5);
  };

  useEffect(() => {
    if (query) setClassifiedTokens(getTokens(query));
    else setClassifiedTokens([]);
  }, [query]);

  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:8000/api/suggest?q=${encodeURIComponent(query)}`);
        if (res.ok) {
          const data = await res.json();
          setCategorizedSuggestions(data.suggestions);
          setPreview(data.preview);
        }
      } catch {}
    }, 100);
    return () => clearTimeout(t);
  }, [query]);

  const runQuery = useCallback((q: string) => {
    const trimmed = q.trim();
    if (!trimmed || isLoading) return;
    setLastSubmitted(trimmed);
    setShowSuggestions(false);
    onSubmit(trimmed);
  }, [isLoading, onSubmit]);

  const handleTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    setSelectedIndex(-1);
    if (onQueryChange) onQueryChange(val);
  };

  const handleTagClick = (tag: string) => {
    if (/^PRJ-[A-Z]+-\d+$/i.test(tag)) {
      setQuery(tag);
      setSelectedIndex(-1);
      if (onQueryChange) onQueryChange(tag);
      runQuery(tag);
      return;
    }
    const next = (query + ' ' + tag).trim();
    setQuery(next);
    setSelectedIndex(-1);
    if (onQueryChange) onQueryChange(next);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const flatSuggestions = [
    ...categorizedSuggestions.metrics,
    ...categorizedSuggestions.analysis,
    ...categorizedSuggestions.comparisons,
  ];

  const getFlatIndex = (cat: 'metrics' | 'analysis' | 'comparisons', idx: number) => {
    if (cat === 'metrics') return idx;
    if (cat === 'analysis') return categorizedSuggestions.metrics.length + idx;
    return categorizedSuggestions.metrics.length + categorizedSuggestions.analysis.length + idx;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(p => (p < flatSuggestions.length - 1 ? p + 1 : p));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(p => (p > 0 ? p - 1 : -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedIndex >= 0) {
        const s = flatSuggestions[selectedIndex];
        setQuery(s);
        runQuery(s);
      } else {
        runQuery(query);
      }
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
    }
  };

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (isLoading) {
      setShowSuggestions(false);
    }
  }, [isLoading]);

  return (
    <div>
      <div ref={containerRef} className="relative mb-3">
        <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
          {isLoading
            ? <svg className="animate-spin h-4 w-4 text-indigo-500" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
            : <svg className="h-4 w-4 text-indigo-500 dark:text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
          }
        </div>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleTextChange}
          onFocus={() => { setIsFocused(true); }}
          onBlur={() => setIsFocused(false)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about your data…"
          className="w-full pl-10 pr-10 py-2.5 text-sm bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 hover:border-indigo-300 dark:hover:border-indigo-700 text-slate-850 dark:text-slate-100 placeholder-slate-450 rounded-2xl focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:focus:ring-indigo-600 focus:border-transparent transition-all shadow-sm font-medium"
        />
        <button
          type="button"
          onClick={() => {
            setShowSuggestions(prev => !prev);
            inputRef.current?.focus();
          }}
          className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-gray-400 hover:text-indigo-500 transition-colors cursor-pointer"
          title="Toggle search suggestions"
        >
          <svg className={`h-4 w-4 transform transition-transform duration-200 ${showSuggestions ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {showSuggestions && !isLoading && (
          <div ref={suggestionListRef} className="absolute z-20 w-full bg-white dark:bg-slate-900 border border-gray-100 dark:border-slate-800 rounded-2xl shadow-2xl mt-2 max-h-72 overflow-y-auto p-2 flex flex-col gap-1">
            {(['metrics', 'analysis', 'comparisons'] as const).map(cat => {
              const items = categorizedSuggestions[cat];
              if (!items.length) return null;
              return (
                <div key={cat}>
                  <div className="text-[10px] font-bold text-gray-400 dark:text-slate-500 uppercase tracking-wider px-3 py-1">{cat}</div>
                  <ul>
                    {items.map((s, idx) => (
                      <li key={`${cat}-${idx}`} className={`px-3 py-2 text-sm cursor-pointer rounded-xl font-medium transition-all ${selectedIndex === getFlatIndex(cat, idx) ? 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-400' : 'hover:bg-gray-50 dark:hover:bg-slate-800 text-gray-700 dark:text-slate-200'}`} onMouseDown={e => { e.preventDefault(); setQuery(s); runQuery(s); }}>{s}</li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {classifiedTokens.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-4">
            {classifiedTokens.map((t, i) => (
                <span key={i} className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase ${
                    t.type === 'UNKNOWN' ? 'bg-red-50 text-red-700 border border-red-200' :
                    t.type === 'METRIC' ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' :
                    t.type === 'DIMENSION' ? 'bg-indigo-50 text-indigo-700 border border-indigo-100' :
                    'bg-slate-50 text-slate-400 border border-slate-100 opacity-60'
                }`}>
                    {t.word}
                </span>
            ))}
        </div>
      )}

      {query.trim().length > 0 && preview && (
        <div className="bg-white dark:bg-slate-900 border border-indigo-100 dark:border-indigo-900/30 rounded-2xl p-4 mb-3 shadow-lg shadow-indigo-50/50 transition-all duration-300">
          <div className="flex items-center justify-between mb-3 pb-2 border-b border-indigo-50 dark:border-indigo-900/20">
            <div className="flex items-center gap-1.5">
              <span className="text-xs">🤖</span>
              <span className="text-[10px] font-black text-indigo-600 dark:text-indigo-400 uppercase tracking-widest">Thought Stream</span>
            </div>
            {isLoading ? <span className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-ping"/> : <span className="text-[8px] font-bold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded">READY</span>}
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="px-2 py-1 rounded-lg text-[10px] font-bold bg-slate-50 dark:bg-slate-800 border border-slate-100 text-slate-600">INTENT: <strong className="text-indigo-600">{preview.intent}</strong></span>
            <span className="px-2 py-1 rounded-lg text-[10px] font-bold bg-slate-50 dark:bg-slate-800 border border-slate-100 text-slate-600">METRIC: <strong className="text-emerald-600">{preview.metric}</strong></span>
            <span className="px-2 py-1 rounded-lg text-[10px] font-bold bg-slate-50 dark:bg-slate-800 border border-slate-100 text-slate-600">BY: <strong className="text-purple-600">{preview.dimension}</strong></span>
          </div>
        </div>
      )}

      {/* Suggested Follow-ups */}
      {results && results.results && (
        <div className="mt-4 pt-4 border-t border-gray-100 dark:border-slate-800">
          <p className="text-[10px] font-bold text-gray-400 dark:text-slate-500 uppercase tracking-widest mb-3">Suggested Follow-ups</p>
          <div className="space-y-1.5">
            {getFollowUpQuestions().map((q, idx) => (
              <button key={idx} onClick={() => { setQuery(q); runQuery(q); }} disabled={isLoading} className="w-full flex items-center justify-between text-left px-3 py-2.5 bg-gray-50 dark:bg-slate-850 hover:bg-indigo-50 border border-gray-100 dark:border-slate-800 hover:border-indigo-200 rounded-xl text-xs font-bold text-slate-700 dark:text-slate-300 hover:text-indigo-700 transition-all group">
                <span className="truncate">{q}</span>
                <svg className="w-3.5 h-3.5 text-gray-400 group-hover:text-indigo-500 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" /></svg>
              </button>
            ))}
          </div>
        </div>
      )}

      <div ref={tagsRef} className="space-y-6 mt-12 pt-8 border-t border-gray-100 dark:border-slate-800">
        <div>
          <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-3">Metrics</h3>
          <div className="flex flex-wrap gap-1.5">
            {metrics.map(m => (
              <button key={m} onClick={() => handleTagClick(m)} className="px-3 py-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-indigo-500 text-slate-650 dark:text-slate-350 text-xs font-semibold rounded-full transition-all hover:bg-slate-50 dark:hover:bg-slate-850">{String(m).toLowerCase()}</button>
            ))}
          </div>
        </div>
        {ORDERED_CATEGORIES.map(title => {
          const items = categoricals[title];
          if (!Array.isArray(items)) return null;
          return (
            <div key={title}>
              <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-3">{title.replace(/_/g, ' ')}</h3>
              <div className="flex flex-wrap gap-1.5">
                {items.slice(0, 15).map(item => (
                  <button key={String(item)} onClick={() => handleTagClick(String(item))} className="px-3 py-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-indigo-500 text-slate-650 dark:text-slate-350 text-xs font-semibold rounded-full transition-all hover:bg-slate-50 dark:hover:bg-slate-850">{String(item).toLowerCase()}</button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
