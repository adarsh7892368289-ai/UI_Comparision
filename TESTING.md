# Testing Guide - UI Comparison Extension

Complete testing protocol to verify all features work correctly.

## Pre-Test Setup

### 1. Install Extension
```
1. Open chrome://extensions/
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select project directory
5. Verify extension icon appears in toolbar
```

### 2. Prepare Test Pages
Create two HTML files for testing:

**page1.html** (Baseline):
```html
<!DOCTYPE html>
<html>
<head>
  <title>Test Page 1</title>
  <style>
    .card { 
      background: #4CAF50; 
      padding: 20px; 
      margin: 10px;
      color: white;
    }
    #header { 
      font-size: 24px; 
      font-family: Arial;
    }
    button { 
      background: blue; 
      padding: 10px 20px;
    }
  </style>
</head>
<body>
  <div id="header">Welcome</div>
  <div class="card" data-testid="card-1">
    <h2>Card Title</h2>
    <p>Card content goes here</p>
    <button data-testid="submit-btn">Submit</button>
  </div>
  <div class="card">
    <h2>Another Card</h2>
    <p>More content</p>
  </div>
</body>
</html>
```

**page2.html** (Modified):
```html
<!DOCTYPE html>
<html>
<head>
  <title>Test Page 2</title>
  <style>
    .card { 
      background: red;        /* Changed color */
      padding: 30px;          /* Changed padding */
      margin: 10px;
      color: white;
    }
    #header { 
      font-size: 32px;        /* Changed size */
      font-family: Arial;
    }
    button { 
      background: green;      /* Changed color */
      padding: 15px 25px;     /* Changed padding */
    }
  </style>
</head>
<body>
  <div id="header">Welcome</div>
  <div class="card" data-testid="card-1">
    <h2>Card Title</h2>
    <p>Card content goes here</p>
    <button data-testid="submit-btn">Submit</button>
  </div>
  <div class="card">
    <h2>Another Card</h2>
    <p>More content</p>
  </div>
  <!-- New element added -->
  <div class="card">
    <h2>New Card</h2>
    <p>This is new</p>
  </div>
</body>
</html>
```

## Test Suite

### Phase 0: Infrastructure (5 tests)

#### Test 0.1: Extension Loads
```
✓ PASS: Extension icon visible in toolbar
✓ PASS: Click icon → popup opens
✓ PASS: No console errors
✓ PASS: Two tabs visible (Extract, Compare)
```

#### Test 0.2: Logging System
```
1. Open browser console (F12)
2. Click extension icon
Expected: See "[INFO] Popup opened" message
✓ PASS: Structured log entries visible
```

#### Test 0.3: Storage System
```
1. Navigate to test page
2. Extract elements
3. Check chrome://extensions/ → Storage
Expected: Report data saved
✓ PASS: Storage contains report
```

#### Test 0.4: Error Tracking
```
1. Try to extract from chrome://extensions/
Expected: Error message displayed
✓ PASS: Error handled gracefully
```

#### Test 0.5: Configuration
```
1. Verify defaults.js loaded
2. Check config values accessible
✓ PASS: Config system functional
```

---

### Phase 1: Extraction (10 tests)

#### Test 1.1: Basic Extraction
```
1. Open page1.html
2. Click extension → Extract Elements
Expected:
  ✓ PASS: Status shows "Extracting..."
  ✓ PASS: Completes with success message
  ✓ PASS: Report appears in list
  ✓ PASS: Element count shown (should be ~10-15)
```

#### Test 1.2: Filter by Class
```
1. Open page1.html
2. Enter "card" in class filter
3. Click Extract
Expected:
  ✓ PASS: Only extracts .card elements + children
  ✓ PASS: Element count lower than full extraction
  ✓ PASS: Includes h2, p, button inside cards
```

#### Test 1.3: Filter by ID
```
1. Open page1.html
2. Enter "header" in ID filter
3. Click Extract
Expected:
  ✓ PASS: Only extracts #header element
  ✓ PASS: Element count = 1
```

#### Test 1.4: Filter by Tag
```
1. Open page1.html
2. Enter "button" in tag filter
3. Click Extract
Expected:
  ✓ PASS: Only extracts button elements
  ✓ PASS: Element count matches button count
```

#### Test 1.5: Multiple Filters (OR logic)
```
1. Open page1.html
2. Enter "card" in class AND "header" in ID
3. Click Extract
Expected:
  ✓ PASS: Extracts BOTH .card AND #header
  ✓ PASS: Uses OR logic (not AND)
```

#### Test 1.6: XPath Generation
```
1. Extract from page1.html
2. Export report as JSON
3. Check first element's selectors.xpath
Expected:
  ✓ PASS: XPath present (not null)
  ✓ PASS: Has confidence score (0-100)
  ✓ PASS: Has strategy name
```

#### Test 1.7: CSS Selector Generation
```
1. Extract from page1.html
2. Export report as JSON
3. Check first element's selectors.css
Expected:
  ✓ PASS: CSS selector present
  ✓ PASS: Has confidence score
  ✓ PASS: Has strategy name
```

#### Test 1.8: Style Collection
```
1. Extract from page1.html
2. Export report as JSON
3. Check element styles object
Expected:
  ✓ PASS: Contains background-color
  ✓ PASS: Contains padding
  ✓ PASS: Contains font-size (for header)
  ✓ PASS: 20+ properties collected
```

#### Test 1.9: Position Calculation
```
1. Extract from page1.html
2. Export report as JSON
3. Check element position object
Expected:
  ✓ PASS: Contains x, y coordinates
  ✓ PASS: Contains width, height
  ✓ PASS: Values are numbers
```

#### Test 1.10: Visibility Detection
```
1. Add hidden element to test page:
   <div style="display:none">Hidden</div>
2. Extract with skipInvisible=true (default)
Expected:
  ✓ PASS: Hidden element not extracted
```

---

### Phase 2: Report Management (7 tests)

#### Test 2.1: Report List Display
```
1. Extract 3 different reports
2. Check reports list in Extract tab
Expected:
  ✓ PASS: All 3 reports visible
  ✓ PASS: Sorted by timestamp (newest first)
  ✓ PASS: Shows element count
  ✓ PASS: Shows URL and timestamp
```

#### Test 2.2: Search Reports
```
1. Have multiple reports
2. Enter search term (e.g., URL part)
3. Verify filtering
Expected:
  ✓ PASS: Only matching reports shown
  ✓ PASS: Updates in real-time
```

#### Test 2.3: Delete Single Report
```
1. Click delete button on report
2. Confirm deletion
Expected:
  ✓ PASS: Report removed from list
  ✓ PASS: Other reports remain
```

#### Test 2.4: Delete All Reports
```
1. Click "Delete All" button
2. Confirm deletion
Expected:
  ✓ PASS: Confirmation dialog shown
  ✓ PASS: All reports removed
  ✓ PASS: Empty state displayed
```

#### Test 2.5: Export Report (JSON)
```
1. Click export button on report
2. Check downloaded file
Expected:
  ✓ PASS: JSON file downloads
  ✓ PASS: Valid JSON structure
  ✓ PASS: Contains all report data
```

#### Test 2.6: Storage Stats
```
1. Extract multiple reports
2. Check storage stats display
Expected:
  ✓ PASS: Shows report count
  ✓ PASS: Shows total elements
  ✓ PASS: Shows storage usage (MB)
  ✓ PASS: Shows percentage used
```

#### Test 2.7: Storage Quota Warning
```
1. Extract many large reports (approach 10MB limit)
Expected:
  ✓ PASS: Warning shown at 80% usage
  ✓ PASS: Color changes (green → yellow → red)
```

---

### Phase 3: Filters (3 tests - Already covered in Phase 1)

✓ All filter tests completed in Phase 1

---

### Phase 4: Normalization (8 tests)

#### Test 4.1: Color Normalization (Hex)
```
Test: Compare #FF0000 vs rgb(255, 0, 0)
1. Create two pages with different color formats
2. Extract both
3. Compare
Expected:
  ✓ PASS: No color difference reported
  ✓ PASS: Both normalized to rgba(255, 0, 0, 1)
```

#### Test 4.2: Color Normalization (Named)
```
Test: Compare "red" vs "#FF0000"
Expected:
  ✓ PASS: No difference reported
```

#### Test 4.3: Color Normalization (HSL)
```
Test: Compare hsl(0, 100%, 50%) vs red
Expected:
  ✓ PASS: No difference reported
```

#### Test 4.4: Unit Normalization (em → px)
```
Test: Compare 1.5em vs 24px (parent font: 16px)
Expected:
  ✓ PASS: No difference reported
  ✓ PASS: Both converted to 24.00px
```

#### Test 4.5: Unit Normalization (rem → px)
```
Test: Compare 1.5rem vs 24px (root font: 16px)
Expected:
  ✓ PASS: No difference reported
```

#### Test 4.6: Unit Normalization (% → px)
```
Test: Compare 50% width vs 500px (parent width: 1000px)
Expected:
  ✓ PASS: No difference reported
```

#### Test 4.7: Font Normalization
```
Test: Compare "arial" vs "Arial"
Expected:
  ✓ PASS: No difference reported
  ✓ PASS: Both standardized
```

#### Test 4.8: Shorthand Expansion
```
Test: Compare "margin: 10px" vs individual margins
Expected:
  ✓ PASS: Expanded to margin-top, margin-right, etc.
  ✓ PASS: No differences when values match
```

---

### Phase 5-6: Comparison (12 tests)

#### Test 5.1: Perfect Match
```
1. Extract from page1.html twice
2. Compare both reports
Expected:
  ✓ PASS: 100% match rate
  ✓ PASS: 0 differences
  ✓ PASS: All elements matched
```

#### Test 5.2: Test Attribute Matching
```
1. Extract page1 (has data-testid="submit-btn")
2. Modify styles but keep data-testid
3. Extract page2
4. Compare
Expected:
  ✓ PASS: Button matched via test attribute
  ✓ PASS: Match confidence = 1.0
  ✓ PASS: Strategy = "test-attribute"
```

#### Test 5.3: ID Matching
```
1. Extract page1 (has id="header")
2. Modify styles but keep ID
3. Extract page2
4. Compare
Expected:
  ✓ PASS: Header matched via ID
  ✓ PASS: Match confidence = 0.95
  ✓ PASS: Strategy = "id"
```

#### Test 5.4: CSS Selector Matching
```
1. Extract page1 (has class="card")
2. Modify content but keep class
3. Extract page2
4. Compare
Expected:
  ✓ PASS: Cards matched via CSS selector
  ✓ PASS: Match confidence >= 0.85
```

#### Test 5.5: Color Difference Detection
```
Using page1.html vs page2.html:
- Card background: green → red
Expected:
  ✓ PASS: Color difference detected
  ✓ PASS: Property = "background-color"
  ✓ PASS: Severity = "high"
```

#### Test 5.6: Size Difference Detection
```
Using page1.html vs page2.html:
- Header font-size: 24px → 32px
Expected:
  ✓ PASS: Size difference detected
  ✓ PASS: Property = "font-size"
  ✓ PASS: Severity = "high" (>25% change)
```

#### Test 5.7: Padding Difference Detection
```
Using page1.html vs page2.html:
- Card padding: 20px → 30px
Expected:
  ✓ PASS: Padding difference detected
  ✓ PASS: Property = "padding"
  ✓ PASS: Severity = "medium"
```

#### Test 5.8: Unmatched Elements (Added)
```
Using page1.html vs page2.html:
- page2 has extra card
Expected:
  ✓ PASS: Shows "1 added"
  ✓ PASS: In unmatched compare list
```

#### Test 5.9: Static Mode
```
1. Compare page1 vs page2 in Static mode
Expected:
  ✓ PASS: All properties compared
  ✓ PASS: Content differences included
```

#### Test 5.10: Dynamic Mode
```
1. Compare page1 vs page2 in Dynamic mode
Expected:
  ✓ PASS: Structural differences only
  ✓ PASS: Content differences ignored
```

#### Test 5.11: Severity Breakdown
```
1. Compare page1 vs page2
2. Check severity counts
Expected:
  ✓ PASS: Critical count displayed
  ✓ PASS: High count displayed (color changes)
  ✓ PASS: Medium count displayed (padding)
  ✓ PASS: Low count displayed
```

#### Test 5.12: Match Rate Calculation
```
1. Compare page1 vs page2
2. Check match rate
Expected:
  ✓ PASS: Percentage shown (e.g., 85%)
  ✓ PASS: Matches actual matched count
```

---

### Phase 7: Export (4 tests)

#### Test 7.1: Excel Export
```
1. Complete comparison
2. Click Export → Select "1" (Excel)
3. Open downloaded .xlsx file
Expected:
  ✓ PASS: File downloads
  ✓ PASS: Contains 5 sheets:
    - Summary
    - Matched Elements
    - Differences
    - Unmatched Elements
    - By Severity
  ✓ PASS: Data properly formatted
  ✓ PASS: Opens in Excel/LibreOffice
```

#### Test 7.2: CSV Export
```
1. Complete comparison
2. Click Export → Select "2" (CSV)
3. Open downloaded .csv file
Expected:
  ✓ PASS: File downloads
  ✓ PASS: Contains differences data
  ✓ PASS: Properly escaped commas/quotes
  ✓ PASS: Opens in spreadsheet software
```

#### Test 7.3: HTML Export
```
1. Complete comparison
2. Click Export → Select "3" (HTML)
3. Open downloaded .html file in browser
Expected:
  ✓ PASS: File downloads
  ✓ PASS: Beautiful visual report
  ✓ PASS: Contains all sections:
    - Summary
    - Matching Results
    - Severity Breakdown
    - Differences table
    - Unmatched elements
  ✓ PASS: Styling intact
  ✓ PASS: Responsive design
```

#### Test 7.4: JSON Export
```
1. Complete comparison
2. Click Export → Select "4" (JSON)
3. Open downloaded .json file
Expected:
  ✓ PASS: File downloads
  ✓ PASS: Valid JSON structure
  ✓ PASS: Contains complete comparison result
  ✓ PASS: Can be parsed programmatically
```

---

### Phase 8: Polish & Integration (5 tests)

#### Test 8.1: Loading Indicators
```
1. Click Extract button
Expected:
  ✓ PASS: Button shows spinner
  ✓ PASS: Button text changes to "Extracting..."
  ✓ PASS: Button disabled during operation
  ✓ PASS: Returns to normal after completion
```

#### Test 8.2: Status Messages
```
1. Perform various operations
Expected:
  ✓ PASS: Success messages (green)
  ✓ PASS: Error messages (red)
  ✓ PASS: Info messages (blue)
  ✓ PASS: Checkmark (✓) for success
  ✓ PASS: Cross (✗) for errors
```

#### Test 8.3: Error Handling
```
1. Try to extract from chrome://extensions/
Expected:
  ✓ PASS: Error message displayed
  ✓ PASS: No crash
  ✓ PASS: Error logged to console
```

#### Test 8.4: Performance
```
1. Extract 500+ elements
2. Measure time
Expected:
  ✓ PASS: Completes in <15 seconds
  ✓ PASS: No UI freezing
  ✓ PASS: Progress visible
```

#### Test 8.5: Cross-Browser
```
Test on:
  □ Chrome 88+
  □ Edge 88+ (Chromium)
Expected:
  ✓ PASS: Works on all supported browsers
```

---

## Performance Benchmarks

### Extraction Performance
```
| Elements | Expected Time | Acceptable Range |
|----------|---------------|------------------|
| 50       | ~1s           | 0.5-2s           |
| 150      | ~3s           | 2-5s             |
| 500      | ~10s          | 8-15s            |
| 1000     | ~18s          | 15-25s           |
```

### Comparison Performance
```
| Pairs | Expected Time | Acceptable Range |
|-------|---------------|------------------|
| 50    | ~50ms         | 30-100ms         |
| 150   | ~130ms        | 100-200ms        |
| 500   | ~450ms        | 300-600ms        |
| 1000  | ~900ms        | 700-1200ms       |
```

### Cache Hit Rates
```
| Cache Type | Target Rate | Acceptable Range |
|------------|-------------|------------------|
| Absolute   | 90%         | 85-95%           |
| Relative   | 70%         | 60-80%           |
```

---

## Test Results Summary

### Total Tests: 69

**Phase 0 (Infrastructure)**: 5 tests
**Phase 1 (Extraction)**: 10 tests
**Phase 2 (Report Management)**: 7 tests
**Phase 3 (Filters)**: 3 tests (covered in Phase 1)
**Phase 4 (Normalization)**: 8 tests
**Phase 5-6 (Comparison)**: 12 tests
**Phase 7 (Export)**: 4 tests
**Phase 8 (Polish)**: 5 tests

---

## Automated Testing (Future)

### Unit Tests
- Color normalization functions
- Unit conversion accuracy
- Matching strategy correctness
- Severity calculations

### Integration Tests
- Full extraction workflow
- Complete comparison workflow
- Export format validity

### E2E Tests
- User interaction flows
- Error recovery paths
- Performance regression

---

## Troubleshooting Common Issues

### "Extension failed to load"
- Check manifest.json syntax
- Verify all file paths
- Check for console errors

### "Extraction timeout"
- Increase perElementTimeout in config
- Reduce maxElements limit
- Check for JavaScript errors on page

### "Comparison shows all differences"
- Verify normalization working (check logs)
- Ensure both pages fully loaded
- Check tolerance thresholds

### "Export fails"
- Verify XLSX library loaded
- Check browser storage available
- Try different export format

---

## Sign-Off Checklist

Before considering testing complete, verify:

- [ ] All 69 tests passing
- [ ] No console errors
- [ ] Performance within acceptable ranges
- [ ] All export formats working
- [ ] Documentation accurate
- [ ] Edge cases handled
- [ ] Error messages helpful
- [ ] UI responsive
- [ ] Icons present (or placeholder noted)
- [ ] README complete

---

## Bug Reporting Template

```
**Bug**: [Brief description]

**Steps to Reproduce**:
1. 
2. 
3. 

**Expected**: [What should happen]

**Actual**: [What actually happened]

**Environment**:
- Browser: Chrome [version]
- OS: [operating system]
- Extension version: 1.0.0

**Console Errors**: [Any errors in console]

**Screenshots**: [If applicable]
```