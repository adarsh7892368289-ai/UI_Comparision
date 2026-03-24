/**
 * Redux-style state machine for the popup UI: holds UI state, dispatches transitions,
 * and notifies subscribers synchronously after each state change.
 * Runs in the popup execution context.
 * Invariant: `state` is always replaced with a new object — never mutated in place.
 * Called by: popup.js for all UI state reads and writes.
 */

// Canonical empty state; also used by the RESET transition to return to baseline.
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
  compareMode: 'dynamic',
  comparisonResult: null,
  cachedAt: null,
  error: null
};

// Each transition is a pure function: (state, payload) => newState.
// Transitions never throw — dispatch is always safe to call.
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

  IMPORT_COMPLETE: (state, { report }) => ({
    ...state,
    // Replace existing entry with same ID to avoid duplicates from re-imports.
    reports: [report, ...state.reports.filter(r => r.id !== report.id)]
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

  DELETE_ALL_REPORTS: (state) => ({
    ...state,
    reports: [],
    selectedBaseline: null,
    selectedCompare: null,
    comparisonResult: null,
    comparisonProgress: 0,
    comparisonLabel: '',
    cachedAt: null
  }),

  COMPARISON_CACHED: (state, { cachedAt }) => ({
    ...state,
    cachedAt
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
  }),

  RESET: () => ({ ...initialState })
};

/**
 * Synchronous Redux-style store for popup UI state.
 * Does NOT own persistence — state is lost when the popup closes.
 * Invariant: listeners must not dispatch inside their callback — synchronous re-entrancy
 * is not detected and will cause listeners to fire in an unexpected order.
 */
class PopupState {
  /** Initialises with `initialState`; history buffer capped at 50 entries. */
  constructor() {
    this.state = initialState;
    this.listeners = [];
    this.history = [];
    this.maxHistorySize = 50;
  }

  /**
   * Applies a named transition to the current state and notifies all listeners.
   * Logs and returns early for unknown transition types rather than throwing.
   *
   * @param {string} type - Transition name (e.g. `'EXTRACTION_STARTED'`).
   * @param {object} payload - Data passed to the transition function.
   */
  dispatch(type, payload = {}) {
    const transition = transitions[type];

    if (!transition) {
      console.error(`Unknown transition: ${type}`); // eslint-disable-line no-console
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
        console.error('State listener error:', error); // eslint-disable-line no-console
      }
    });
  }

  /**
   * Registers a listener that is called immediately with the current state (as `'INIT'`)
   * and again after every subsequent `dispatch`. Returns an unsubscribe function.
   *
   * @param {(state: object, type: string, payload: object, prevState: object|null) => void} fn
   * @returns {() => void} Call to remove this listener.
   */
  subscribe(fn) {
    this.listeners.push(fn);
    fn(this.state, 'INIT', {}, null);

    return () => {
      this.listeners = this.listeners.filter(l => l !== fn);
    };
  }

  /** Returns the current state object. Do not mutate the returned object. */
  get() {
    return this.state;
  }

  /** Returns a shallow copy of the dispatch history for debugging. */
  getHistory() {
    return [...this.history];
  }

  /** Resets state to `initialState` and clears history, then fires RESET listeners. */
  reset() {
    this.state = initialState;
    this.history = [];
    this.dispatch('RESET', {});
  }
}

// Singleton shared across all popup.js imports.
const popupState = new PopupState();

export { popupState, PopupState };