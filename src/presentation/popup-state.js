const initialState = {
  activeTab: 'extract',
  reports: [],
  search: '',
  isExtracting: false,
  isComparing: false,
  extractionProgress: 0,
  extractionLabel: '',
  comparisonProgress: 0,
  comparisonLabel: '',
  selectedBaseline: null,
  selectedCompare: null,
  compareMode: 'static',
  comparisonResult: null,
  cachedAt: null,
  error: null,
};

const transitions = {
  TAB_CHANGED: (state, { tab }) => ({
    ...state,
    activeTab: tab,
    error: null
  }),

  SEARCH_CHANGED: (state, { query }) => ({
    ...state,
    search: query
  }),

  EXTRACTION_STARTED: (state) => ({
    ...state,
    isExtracting: true,
    extractionProgress: 0,
    extractionLabel: 'Starting extraction...',
    error: null
  }),

  EXTRACTION_PROGRESS: (state, { progress, label }) => ({
    ...state,
    extractionProgress: progress,
    extractionLabel: label
  }),

  EXTRACTION_COMPLETE: (state, { report }) => ({
    ...state,
    isExtracting: false,
    extractionProgress: 100,
    extractionLabel: 'Complete',
    reports: [report, ...state.reports]
  }),

  EXTRACTION_FAILED: (state, { error }) => ({
    ...state,
    isExtracting: false,
    extractionProgress: 0,
    extractionLabel: '',
    error
  }),

  COMPARISON_STARTED: (state) => ({
    ...state,
    isComparing: true,
    comparisonProgress: 0,
    comparisonLabel: 'Starting comparison...',
    comparisonResult: null,
    error: null
  }),

  COMPARISON_PROGRESS: (state, { progress, label }) => ({
    ...state,
    comparisonProgress: progress,
    comparisonLabel: label
  }),

  COMPARISON_COMPLETE: (state, { result, cachedAt = null }) => ({
    ...state,
    isComparing: false,
    comparisonProgress: 100,
    comparisonLabel: 'Complete',
    comparisonResult: result,
    cachedAt
  }),

  COMPARISON_FAILED: (state, { error }) => ({
    ...state,
    isComparing: false,
    comparisonProgress: 0,
    comparisonLabel: '',
    cachedAt: null,
    error
  }),

  REPORTS_LOADED: (state, { reports }) => ({
    ...state,
    reports
  }),

  REPORT_DELETED: (state, { id }) => ({
    ...state,
    reports: state.reports.filter(r => r.id !== id),
    selectedBaseline: state.selectedBaseline === id ? null : state.selectedBaseline,
    selectedCompare: state.selectedCompare === id ? null : state.selectedCompare
  }),

  BASELINE_SELECTED: (state, { id }) => ({
    ...state,
    selectedBaseline: id
  }),

  COMPARE_SELECTED: (state, { id }) => ({
    ...state,
    selectedCompare: id
  }),

  MODE_CHANGED: (state, { mode }) => ({
    ...state,
    compareMode: mode
  }),

  ERROR_CLEARED: (state) => ({
    ...state,
    error: null
  }),

  RESET_COMPARISON: (state) => ({
    ...state,
    comparisonResult: null,
    comparisonProgress: 0,
    comparisonLabel: '',
    cachedAt: null,
    isComparing: false
  })
};

class PopupState {
  constructor() {
    this.state = initialState;
    this.listeners = [];
    this.history = [];
    this.maxHistorySize = 50;
  }

  dispatch(type, payload = {}) {
    const transition = transitions[type];
    
    if (!transition) {
      console.error(`Unknown transition: ${type}`);
      return;
    }

    const prevState = this.state;
    this.state = transition(this.state, payload);

    this.history.push({ type, payload, timestamp: Date.now() });
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }

    this.listeners.forEach(fn => {
      try {
        fn(this.state, type, payload, prevState);
      } catch (error) {
        console.error('State listener error:', error);
      }
    });
  }

  subscribe(fn) {
    this.listeners.push(fn);
    fn(this.state, 'INIT', {}, null);
    
    return () => {
      this.listeners = this.listeners.filter(l => l !== fn);
    };
  }

  get() {
    return this.state;
  }

  getHistory() {
    return [...this.history];
  }

  reset() {
    this.state = initialState;
    this.history = [];
    this.dispatch('RESET', {});
  }
}

const popupState = new PopupState();

export { popupState, PopupState };