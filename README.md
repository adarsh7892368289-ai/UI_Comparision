# UI Comparison

A Chrome extension for visual and structural UI comparison and regression testing.

## Project Structure

```
UI_Comparison/
├── .eslintrc.json          # ESLint configuration
├── .gitignore              # Git ignore rules
├── .prettierrc             # Prettier configuration
├── manifest.json           # Chrome extension manifest
├── package.json            # Project dependencies
├── webpack.config.cjs      # Webpack configuration
├── icons/                  # Extension icons
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── libs/                   # Third-party libraries
│   ├── DOWNLOAD_XLSX_LIBRARY.txt
│   └── xlsx.full.min.js
└── src/
    ├── application/        # Application-level workflows
    │   ├── background.js           # Background script
    │   ├── compare-workflow.js     # Comparison workflow
    │   ├── export-workflow.js     # Export workflow
    │   ├── extract-workflow.js    # Extraction workflow
    │   ├── report-manager.js      # Report management
    │   ├── url-compatibility.js   # URL compatibility checks
    │   └── visual-workflow.js     # Visual workflow
    │
    ├── config/             # Configuration files
    │   ├── defaults.js             # Default settings
    │   └── validator.js            # Configuration validator
    │
    ├── core/               # Core business logic
    │   ├── comparison/             # Comparison engine
    │   │   ├── async-utils.js      # Async utilities
    │   │   ├── color-utils.js      # Color comparison utils
    │   │   ├── comparator.js       # Main comparator
    │   │   ├── comparison-modes.js # Comparison mode definitions
    │   │   ├── differ.js            # Difference detection
    │   │   ├── keyframe-grouper.js  # Keyframe grouping
    │   │   ├── matcher.js           # Element matching
    │   │   └── severity-analyzer.js # Severity analysis
    │   │
    │   ├── export/                 # Export functionality
    │   │   ├── comparison/         # Comparison exports
    │   │   │   ├── csv-exporter.js
    │   │   │   ├── excel-exporter.js
    │   │   │   ├── html-exporter.js
    │   │   │   └── json-exporter.js
    │   │   ├── extraction/         # Extraction reports
    │   │   │   └── report-exporter.js
    │   │   └── shared/             # Shared export utilities
    │   │       ├── csv-utils.js
    │   │       ├── download-trigger.js
    │   │       └── report-transformer.js
    │   │
    │   ├── extraction/             # DOM extraction
    │   │   ├── attribute-collector.js
    │   │   ├── dom-enrichment.js
    │   │   ├── dom-traversal.js
    │   │   ├── element-classifier.js
    │   │   ├── extraction-filter.js
    │   │   ├── extractor.js
    │   │   ├── readiness-gate.js
    │   │   ├── section-detector.js
    │   │   └── style-collector.js
    │   │
    │   ├── normalization/         # Style normalization
    │   │   ├── cache.js           # Normalization cache
    │   │   ├── color-normalizer.js
    │   │   ├── font-normalizer.js
    │   │   ├── normalizer-engine.js
    │   │   ├── shorthand-expander.js
    │   │   └── unit-normalizer.js
    │   │
    │   ├── selectors/             # Element selectors
    │   │   ├── selector-engine.js
    │   │   ├── selector-utils.js
    │   │   ├── css/               # CSS selectors
    │   │   │   ├── generator.js
    │   │   │   ├── strategies.js
    │   │   │   └── validator.js
    │   │   └── xpath/             # XPath selectors
    │   │       ├── generator.js
    │   │       ├── strategies.js
    │   │       └── validator.js
    │   │
    │   └── visual/                # Visual comparison
    │
    ├── infrastructure/            # Infrastructure layer
    │   ├── chrome-messaging.js    # Chrome messaging
    │   ├── chrome-tabs.js         # Chrome tab utilities
    │   ├── error-tracker.js       # Error tracking
    │   ├── idb-repository.js      # IndexedDB repository
    │   ├── image-processor.js     # Image processing
    │   ├── logger.js             # Logging utility
    │   ├── performance-monitor.js # Performance monitoring
    │   └── storage.js            # Storage utilities
    │
    └── presentation/             # UI presentation
        ├── content.js            # Content script
        ├── popup-state.js       # Popup state management
        ├── popup.css            # Popup styles
        ├── popup.html           # Popup HTML
        └── popup.js             # Popup script
```

## Architecture Overview

### Application Layer (`src/application/`)

High-level workflows that orchestrate the core modules to accomplish specific tasks.

### Core Layer (`src/core/`)

The main business logic divided into specialized domains:

- **Comparison**: Visual and structural UI comparison
- **Export**: Multi-format export (CSV, Excel, HTML, JSON)
- **Extraction**: DOM element extraction and analysis
- **Normalization**: CSS/style normalization
- **Selectors**: CSS and XPath selector generation

### Infrastructure Layer (`src/infrastructure/`)

Cross-cutting concerns and platform integrations:

- Chrome extension APIs
- Error tracking
- Performance monitoring
- Storage

### Presentation Layer (`src/presentation/`)

User interface components:

- Popup UI
- Content scripts

## Installation

1. Install dependencies:

   ```bash
   npm install
   ```

2. Build the extension:

   ```bash
   npm run build
   ```

3. Load in Chrome:
   - Go to `chrome://extensions/`
   - Enable Developer mode
   - Click "Load unpacked"
   - Select the `dist` folder

## Development

```bash
# Watch mode for development
npm run dev
```

## License

MIT
