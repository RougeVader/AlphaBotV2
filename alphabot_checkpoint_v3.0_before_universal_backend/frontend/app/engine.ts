
// frontend/app/engine.ts

export type TokenType = 'ACTION' | 'METRIC' | 'DIMENSION' | 'TEMPORAL' | 'FLUFF' | 'UNKNOWN' | 'COMPARATOR' | 'VALUE';

export interface ClassifiedToken {
  word: string;
  type: TokenType;
  subType?: string; 
  isNormalized?: boolean;
}

export interface BlueprintComparison {
    metric: string;
    operator: string;
    value: number;
}

export interface QueryBlueprint {
  raw_query: string;
  blueprint: {
    operation: string | null;
    metrics: string[];
    filters: { column: string; value: string }[];
    timeframe: { type: string; value: string } | null;
    comparison: BlueprintComparison | null;
    breakdown_by: string | null;
  };
  warnings: string[];
  parsing_metadata: {
    client_processing_time_ms: number;
    fallback_required: boolean;
    unknown_tokens: string[];
  };
}

class TrieNode {
    children: Record<string, TrieNode> = {};
    isEndOfToken: boolean = false;
    tokenType: TokenType | null = null;
    metadata: any = null;
}

export class MetadataTrie {
    root: TrieNode = new TrieNode();
    insert(phrase: string | number, type: TokenType, metadata: any = null) {
        let node = this.root;
        const words = String(phrase).toLowerCase().split(/\s+/);
        words.forEach(word => {
            if (!node.children[word]) node.children[word] = new TrieNode();
            node = node.children[word];
        });
        node.isEndOfToken = true;
        node.tokenType = type;
        node.metadata = metadata;
    }
    search(words: string[], startIndex: number): [string, TokenType, number, any] | null {
        let node = this.root;
        let longestMatch: [string, TokenType, number, any] | null = null;
        let currentPhrase: string[] = [];
        for (let i = startIndex; i < words.length; i++) {
            // Normalize internal word for lookup
            const word = words[i].toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '');
            if (!node.children[word]) break;
            node = node.children[word];
            currentPhrase.push(word);
            if (node.isEndOfToken) {
                longestMatch = [currentPhrase.join(' '), node.tokenType!, i - startIndex + 1, node.metadata];
            }
        }
        return longestMatch;
    }
}

export const globalTrie = new MetadataTrie();

const STATIC_ACTIONS = ['total', 'sum', 'average', 'avg', 'count', 'max', 'min', 'breakdown', 'improvement', 'ratio', 'rate', 'what', 'show', 'find', 'in', 'by', 'year', 'graph', 'trend', 'which', 'who', 'has', 'list', 'across', 'all', 'sites', 'comparative', 'compare', 'comparison', 'versus', 'vs', 'growth', 'loss', 'change', 'delta', 'compared', 'with'];
const STATIC_FLUFF = ['is', 'the', 'of', 'for', 'a', 'an', 'please', 'kindly', 'select', 'to', 'than', 'at', 'with', 'region', 'department', 'dept', 'give', 'me', 'tell', 'us', 'get', 'site', 'stations', 'project', 'projects', 'metrics', 'data', 'information', 'was', 'from', 'between', 'and', 'tracker', 'unit', 'id', 'details', 'everything', 'all', 'info', 'having', 'days', 'months', 'years', 'day', 'month', 'year'];
const STATIC_METRICS = {
    'revenue': 'revenue', 'income': 'revenue', 'intake': 'revenue',
    'profit': 'profit', 'earnings': 'profit', 'margin': 'profit',
    'expenses': 'expenses', 'expenditure': 'expenses', 'spending': 'expenses', 'cost': 'expenses', 'costs': 'expenses', 'loss': 'expenses',
    'headcount': 'headcount', 'staff': 'headcount', 'employees': 'headcount',
    'salary': 'salary', 'pay': 'salary', 'wages': 'salary',
    'tax_liability': 'tax_liability', 'asset_value': 'asset_value', 'operating_cost': 'operating_cost', 'marketing_spend': 'marketing_spend', 'customer_count': 'customer_count',
    'capacity': 'capacity_mw', 'completion': 'completion_percentage', 'delay': 'delay_days', 'budget': 'budget_allocated', 'budget used': 'budget_used', 'remaining budget': 'budget_remaining', 'growth': 'revenue', 'budget_remaining': 'budget_remaining', 'budget_used': 'budget_used',
    'contractor_payment_status': 'contractor_payment_status', 'payment status': 'contractor_payment_status', 'material_status': 'material_status', 'material status': 'material_status', 'project_id': 'project_id', 'project_name': 'project_name'
};
const STATIC_COMPARATORS: Record<string, string> = { 'less': '<', 'below': '<', 'under': '<', 'greater': '>', 'more': '>', 'above': '>', 'equal': '=', 'equals': '=', 'smaller': '<', 'larger': '>' };

STATIC_ACTIONS.forEach(a => globalTrie.insert(a, 'ACTION'));
STATIC_FLUFF.forEach(f => globalTrie.insert(f, 'FLUFF'));
Object.entries(STATIC_METRICS).forEach(([syn, canonical]) => globalTrie.insert(syn, 'METRIC', { canonical }));
Object.keys(STATIC_COMPARATORS).forEach(c => globalTrie.insert(c, 'COMPARATOR'));

const TEMPORAL_REGEX: Record<string, RegExp> = {
  DATE: /^\d{4}-\d{2}-\d{2}$/,
  FY: /^fy(\d{4})$/i,
  Q: /^q([1-4])(\d{4})?$/i,
  YEAR_RANGE: /^(\d{4})-(\d{4})$/,
  YEAR: /^(\d{4})$/,
};
const VALUE_REGEX = /^-?\d+(\.\d+)?$|unit \d+|PRJ-[A-Z]+-\d+/i;
const PROJECT_ID_REGEX = /^PRJ-[A-Z]+-\d+$/i;
const PROJECT_NAME_REGEX = /\b(darlington|diablo[\s_]+canyon|grand[\s_]+gulf|hinkley[\s_]+point|kashiwazaki|palo[\s_]+verde|three[\s_]+mile[\s_]+island|vogtle)\s+(solar|wind|hybrid|hybrid-wind|hybrid-solar)\s+unit\s+\d+\b/i;

function classifyWords(rawQuery: string): ClassifiedToken[] {
    // Robust normalization: handle multi-spaces and strip non-essential punctuation
    const words = rawQuery.trim().split(/\s+/);
    const tokens: ClassifiedToken[] = [];
    let i = 0;
    while (i < words.length) {
        const trieMatch = globalTrie.search(words, i);
        if (trieMatch) {
            tokens.push({ word: trieMatch[0], type: trieMatch[1] });
            i += trieMatch[2];
            continue;
        }
        
        // Normalize word for regex checks
        const wordNorm = words[i].toLowerCase().replace(/^[^\w\d-]+|[^\w\d-]+$/g, '');
        let matched = false;
        
        for (const subType in TEMPORAL_REGEX) {
            if (TEMPORAL_REGEX[subType].test(wordNorm)) {
                tokens.push({ word: words[i], type: 'TEMPORAL', subType });
                matched = true;
                break;
            }
        }
        if (matched) { i++; continue; }
        
        if (VALUE_REGEX.test(wordNorm)) {
            tokens.push({ word: words[i], type: 'VALUE' });
            matched = true;
        }
        if (matched) { i++; continue; }
        
        tokens.push({ word: words[i], type: 'UNKNOWN' });
        i++;
    }
    return tokens;
}

export function buildBlueprint(rawQuery: string): QueryBlueprint {
    const startTime = performance.now();
    const tokens = classifyWords(rawQuery);
    
    const blueprint: QueryBlueprint = {
        raw_query: rawQuery,
        blueprint: {
            operation: null, metrics: [], filters: [], timeframe: null, comparison: null, breakdown_by: null
        },
        warnings: [],
        parsing_metadata: {
            client_processing_time_ms: 0,
            fallback_required: false,
            unknown_tokens: [],
        },
    };

    // Try to extract year range first to avoid single-year override
    const rangeMatch = rawQuery.match(/\b(20\d{2})\s*(?:-|to)\s*(20\d{2})\b/i);
    if (rangeMatch) {
        blueprint.blueprint.timeframe = { type: 'year_range', value: `${rangeMatch[1]}-${rangeMatch[2]}` };
    }

    // Try to extract project name first to avoid its parts triggering unknown tokens
    const projNameMatch = rawQuery.match(PROJECT_NAME_REGEX);
    let matchedProjectName = "";
    if (projNameMatch) {
        matchedProjectName = projNameMatch[0];
        blueprint.blueprint.filters.push({ column: 'project_name', value: matchedProjectName });
    }

    let i = 0;
    const rawWords = rawQuery.trim().split(/\s+/);
    while (i < rawWords.length) {
        const trieMatch = globalTrie.search(rawWords, i);
        if (trieMatch) {
            const [val, type, consumed, metadata] = trieMatch;
            if (type === 'ACTION') {
                const op = val.toUpperCase();
                if (['GRAPH', 'TREND', 'BREAKDOWN', 'TOTAL', 'WHICH', 'LIST', 'COMPARE', 'GROWTH'].includes(op)) blueprint.blueprint.operation = op;
                else if (!blueprint.blueprint.operation) blueprint.blueprint.operation = op;
            } else if (type === 'METRIC') {
                const canonical = metadata?.canonical || val;
                if (!blueprint.blueprint.metrics.includes(canonical)) blueprint.blueprint.metrics.push(canonical);
            } else if (type === 'DIMENSION') {
                blueprint.blueprint.filters.push({ column: metadata?.column || 'department', value: val });
            }
            i += consumed;
            continue;
        }

        const wordNorm = rawWords[i].toLowerCase().replace(/^[^\w\d-]+|[^\w\d-]+$/g, '');
        if (PROJECT_ID_REGEX.test(wordNorm)) {
            const upperVal = rawWords[i].replace(/^[^\w\d-]+|[^\w\d-]+$/g, '').toUpperCase();
            if (!blueprint.blueprint.filters.some(f => f.column === 'project_id' && f.value === upperVal)) {
                blueprint.blueprint.filters.push({ column: 'project_id', value: upperVal });
            }
            i++;
            continue;
        }

        for (const subType in TEMPORAL_REGEX) {
            if (TEMPORAL_REGEX[subType].test(wordNorm)) {
                if (!blueprint.blueprint.timeframe) {
                    blueprint.blueprint.timeframe = { type: subType.toLowerCase(), value: wordNorm };
                }
                break;
            }
        }
        i++;
    }

    // STRICT FALLBACK LOGIC
    const isProfileQuery = blueprint.blueprint.filters.some(f => f.column === 'project_id' || f.column === 'project_name');
    const hasMetric = blueprint.blueprint.metrics.length > 0 || isProfileQuery;
    const unknownTokens = tokens.filter(t => {
        if (t.type !== 'UNKNOWN') return false;
        if (matchedProjectName && matchedProjectName.toLowerCase().includes(t.word.toLowerCase())) return false;
        return true;
    });
    const hasCriticalUnknowns = unknownTokens.length > 0;
    
    blueprint.parsing_metadata.fallback_required = !hasMetric || hasCriticalUnknowns;
    
    // Warnings generation
    if (hasCriticalUnknowns) {
        blueprint.warnings.push(`Unrecognized terms: ${unknownTokens.map(t => t.word).join(', ')}. AI fallback triggered.`);
    }
    if (!hasMetric) {
        blueprint.warnings.push("No primary metric found. AI will attempt to infer intent.");
    }

    blueprint.parsing_metadata.client_processing_time_ms = performance.now() - startTime;
    blueprint.parsing_metadata.unknown_tokens = unknownTokens.map(t => t.word);
    return blueprint;
}

export function getTokens(rawQuery: string): ClassifiedToken[] {
    return classifyWords(rawQuery);
}
