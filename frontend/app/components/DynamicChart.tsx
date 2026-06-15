
"use client";

import React, { useState } from 'react';
import { Bar, Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  PointElement,
  LineElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import { QueryBlueprint } from '../engine';

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  PointElement,
  LineElement,
  ArcElement,
  Title,
  Tooltip,
  Legend
);

interface DynamicChartProps {
  apiResult: {
    results: any[];
    query_blueprint?: QueryBlueprint;
    blueprint?: any;
    unit?: string;
    metadata?: {
        mode?: string;
        sources?: number;
        blueprint?: any;
    };
  };
}

const TableFallback = ({ results, unit }: { results: any[], unit?: string }) => (
    <div className="w-full h-full min-h-[300px] overflow-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-left border-collapse">
            <thead className="bg-slate-50 sticky top-0">
                <tr>
                    {Object.keys(results[0]).map(k => (
                        <th key={k} className="px-4 py-2 text-[10px] font-black uppercase text-slate-500 tracking-wider border-b border-slate-200">
                            {k.replace(/_/g, ' ')}
                        </th>
                    ))}
                </tr>
            </thead>
            <tbody>
                {results.map((row, i) => (
                    <tr key={i} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                        {Object.entries(row).map(([key, val]: [string, any], j) => (
                            <td key={j} className="px-4 py-2 text-xs font-medium text-slate-700">
                                {typeof val === 'number' ? 
                                    (key === 'growth_pct' ? `${val.toLocaleString()}%` : 
                                     ((unit === 'USD' || unit === '₹ Cr') ? `₹${val.toLocaleString()} Cr` : val.toLocaleString())) : 
                                    String(val)
                                }
                            </td>
                        ))}
                    </tr>
                ))}
            </tbody>
        </table>
    </div>
);

const SingleValueDisplay = ({ value, label, unit }: { value: number | null, label: string, unit?: string }) => {
    if (value === null || value === undefined) {
        return <p className="text-center text-gray-500 font-medium">No records found for this criteria.</p>;
    }
    const unitLabel = (unit === "USD" || unit === "₹ Cr") ? "₹ Cr" : (unit || "");
    return (
        <div className="text-center animate-in zoom-in duration-500 py-4">
            <h3 className="text-[10px] font-black uppercase text-gray-400 tracking-[0.2em] mb-2">
                {label.replace(/_/g, ' ')}
            </h3>
            <div className="relative inline-block">
                <span className="text-6xl font-black text-blue-600 tracking-tighter">
                    {value.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
                <span className="absolute -top-2 -right-16 text-lg font-bold text-blue-300">{unitLabel}</span>
            </div>
            <div className="mt-4 flex justify-center space-x-2">
                <span className="px-2 py-0.5 bg-green-50 text-green-600 text-[8px] font-bold rounded-full uppercase border border-green-100">Verified</span>
                <span className="px-2 py-0.5 bg-blue-50 text-blue-600 text-[8px] font-bold rounded-full uppercase border border-blue-100">Analytical Result</span>
            </div>
        </div>
    );
};

const DynamicChart = ({ apiResult }: DynamicChartProps) => {
  const [viewMode, setViewMode] = useState<'chart' | 'table'>('chart');

  // STAGE 1: SAFE GUARDS
  if (!apiResult || !apiResult.results || apiResult.results.length === 0) {
    return <p className="text-center text-gray-400 font-bold uppercase tracking-widest text-[10px]">No dynamic data available.</p>;
  }

  const { results, unit, metadata } = apiResult;
  
  if (!results[0] || Object.values(results[0]).every(val => val === null)) {
      return <p className="text-center text-slate-400 font-medium">Filtered data set is empty.</p>;
  }

  // STAGE 2: DATA NORMALIZATION
  const safeResults = results.map(r => {
      const entry: any = { ...r };
      Object.keys(entry).forEach(k => {
          if (typeof entry[k] === 'string' && !isNaN(Number(entry[k])) && entry[k] !== '') {
              entry[k] = Number(entry[k]);
          }
      });
      return entry;
  });

  const numericKeys = Object.keys(safeResults[0]).filter(k => typeof safeResults[0][k] === 'number' && k !== 'label');
  const labels = safeResults.map(r => r.label || r[Object.keys(r).find(k => typeof r[k] === 'string') || ''] || 'Point');
  
  const isSiteComparison = metadata?.mode === "Site Comparison";
  const isGrowth = numericKeys.includes('growth_pct');

  // Check for Case 7: Metric Correlation Scale Clash & Case 10: Outlier Log-Scaling
  let hasScaleClash = false;
  let useLogScale = false;
  
  if (numericKeys.length > 1) {
      const maxValues = numericKeys.map(key => Math.max(...safeResults.map(r => Number(r[key]) || 0)));
      const minNonZero = numericKeys.map(key => Math.min(...safeResults.map(r => Number(r[key]) || Infinity).filter(v => v > 0)));
      
      // Case 7 check: >50x disparity between any two metrics
      for (let i = 0; i < maxValues.length; i++) {
          for (let j = i + 1; j < maxValues.length; j++) {
              if (maxValues[i] > 0 && maxValues[j] > 0) {
                  const ratio = maxValues[i] / maxValues[j];
                  if (ratio > 50 || ratio < 0.02) {
                      hasScaleClash = true;
                  }
              }
          }
      }
      
      // Case 10 check: >1000x disparity between max and min non-zero in any metric
      for (let i = 0; i < maxValues.length; i++) {
          if (maxValues[i] > 0 && minNonZero[i] !== Infinity) {
              const ratio = maxValues[i] / minNonZero[i];
              if (ratio > 1000) {
                  useLogScale = true;
              }
          }
      }
  } else if (numericKeys.length === 1) {
      const key = numericKeys[0];
      const maxVal = Math.max(...safeResults.map(r => Number(r[key]) || 0));
      const minVal = Math.min(...safeResults.map(r => Number(r[key]) || Infinity).filter(v => v > 0));
      if (maxVal > 0 && minVal !== Infinity) {
          if (maxVal / minVal > 1000) {
              useLogScale = true;
          }
      }
  }

  // Map metric keys to axes
  const metricToAxis: Record<string, string> = {};
  if (numericKeys.length > 1 && hasScaleClash) {
      const maxValuesMap = numericKeys.map(key => ({
          key,
          maxVal: Math.max(...safeResults.map(r => Number(r[key]) || 0))
      }));
      maxValuesMap.sort((a, b) => b.maxVal - a.maxVal);
      
      metricToAxis[maxValuesMap[0].key] = 'y';
      for (let i = 1; i < maxValuesMap.length; i++) {
          metricToAxis[maxValuesMap[i].key] = 'y1';
      }
  } else {
      numericKeys.forEach(k => {
          metricToAxis[k] = k === 'growth_pct' ? 'y1' : 'y';
      });
  }

  const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 1000, easing: 'easeInOutQuart' as const },
    plugins: {
      legend: {
        position: 'bottom' as const,
        display: !isSiteComparison && numericKeys.length > 1,
        labels: { boxWidth: 12, font: { size: 10, weight: 'bold' as const }, padding: 20 }
      },
      tooltip: {
          backgroundColor: 'rgba(15, 23, 42, 0.9)',
          titleFont: { size: 12, weight: 'bold' as const },
          bodyFont: { size: 11 },
          padding: 12,
          cornerRadius: 8,
          displayColors: true
      }
    },
    scales: {
        y: {
            type: useLogScale ? 'logarithmic' as const : 'linear' as const,
            beginAtZero: !useLogScale,
            position: 'left' as const,
            grid: { color: 'rgba(0,0,0,0.03)' },
            ticks: {
                callback: (value: any) => {
                    if (unit === 'USD' || unit === '₹ Cr') return `₹${value.toLocaleString()} Cr`;
                    return value.toLocaleString();
                },
                font: { size: 10, weight: 'bold' as const }
            }
        },
        y1: {
            beginAtZero: true,
            position: 'right' as const,
            display: isGrowth || hasScaleClash,
            grid: { drawOnChartArea: false },
            ticks: {
                callback: (value: any) => {
                    if (isGrowth && !hasScaleClash) return `${value}%`;
                    return value.toLocaleString();
                },
                font: { size: 10, weight: 'bold' as const }
            }
        },
        x: {
            grid: { display: false },
            ticks: { font: { size: 10, weight: 'bold' as const } }
        }
    }
  };

  // PERSISTENT WRAPPER (This ensures the toggle is ALWAYS there)
  const UnifiedWrapper = ({ children }: { children: React.ReactNode }) => (
    <div className="w-full h-full relative group flex flex-col">
        <div className="absolute top-0 right-0 z-50 flex items-center space-x-2">
            <button 
                onClick={() => setViewMode(viewMode === 'chart' ? 'table' : 'chart')}
                className="opacity-0 group-hover:opacity-100 transition-opacity bg-white/90 backdrop-blur-sm border border-slate-200 text-slate-600 px-3 py-1.5 rounded-full text-[9px] font-black uppercase tracking-tight shadow-md hover:bg-slate-50 hover:scale-105 active:scale-95 transition-all"
            >
                {viewMode === 'chart' ? 'View as Table' : 'Revert to Chart'}
            </button>
        </div>
        <div className="flex-1 w-full h-full flex items-center justify-center min-h-0 overflow-hidden">
            {children}
        </div>
    </div>
  );

  // 0. Decision Path: Table Mode
  if (viewMode === 'table' || numericKeys.length === 0) {
      return (
          <UnifiedWrapper>
              <TableFallback results={safeResults} unit={unit} />
          </UnifiedWrapper>
      );
  }

  // 1. Decision Path: Single Value
  if (safeResults.length === 1 && numericKeys.length === 1 && !isSiteComparison) {
      return (
          <UnifiedWrapper>
              <SingleValueDisplay value={safeResults[0][numericKeys[0]]} label={numericKeys[0]} unit={unit} />
          </UnifiedWrapper>
      );
  }

  // 2. Decision Path: Visual Charts
  const datasets = numericKeys.map((key, index) => {
    const axis = metricToAxis[key];
    const isLine = key === 'growth_pct' || (hasScaleClash && axis === 'y1');
    return {
        label: key.replace(/_/g, ' '),
        data: safeResults.map(r => r[key]),
        yAxisID: axis,
        backgroundColor: ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'][index % 6],
        borderColor: ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'][index % 6],
        borderWidth: isLine ? 2 : 0,
        borderRadius: isLine ? 0 : 6,
        hoverBackgroundColor: '#1e293b',
        type: isLine ? 'line' as const : undefined,
    };
  });

  const chartData = { labels, datasets };
  const operation = apiResult.blueprint?.operation || apiResult.metadata?.blueprint?.operation || apiResult.query_blueprint?.blueprint?.operation;
  const useLine = operation === 'GRAPH' || operation === 'TREND';

  return (
    <UnifiedWrapper>
        {useLine ? (
            <Line 
                data={{
                    ...chartData,
                    datasets: datasets.map(ds => ({
                        ...ds,
                        borderWidth: 3,
                        tension: 0.4,
                        pointRadius: 4,
                        pointHoverRadius: 6,
                        fill: false
                    }))
                } as any} 
                options={commonOptions as any} 
            />
        ) : (
            <Bar data={chartData as any} options={commonOptions as any} />
        )}
    </UnifiedWrapper>
  );
};

export default DynamicChart;
