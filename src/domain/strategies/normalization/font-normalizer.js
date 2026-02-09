/**
 * FONT FAMILY NORMALIZER
 * Standardizes font-family strings for accurate comparison
 * 
 * Handles:
 * - Quote removal: "Inter" → Inter
 * - Spacing normalization: "Inter,  sans-serif" → "Inter, sans-serif"
 * - Generic family lowercasing: "SANS-SERIF" → "sans-serif"
 * - Optional: sorting for comparison (disabled by default)
 */

export class FontNormalizer {
  constructor(options = {}) {
    this.sortFamilies = options.sortFamilies || false;
  }
  
  // Normalize font-family value
  normalize(value) {
    if (!value || typeof value !== 'string') return value;
    
    let normalized = value;
    
    // 1. Remove quotes (both single and double)
    normalized = normalized.replace(/["']/g, '');
    
    // 2. Normalize spacing around commas
    normalized = normalized.replace(/\s*,\s*/g, ', ');
    
    // 3. Split into individual families
    const families = normalized.split(',').map(f => f.trim());
    
    // 4. Lowercase generic families
    const genericFamilies = ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui'];
    
    const processedFamilies = families.map(family => {
      const lower = family.toLowerCase();
      return genericFamilies.includes(lower) ? lower : family;
    });
    
    // 5. Optional: Sort families (for comparison)
    // Note: Disabled by default because font-family order matters for CSS
    if (this.sortFamilies) {
      // Keep generic families at the end
      const specific = processedFamilies.filter(f => !genericFamilies.includes(f.toLowerCase()));
      const generic = processedFamilies.filter(f => genericFamilies.includes(f.toLowerCase()));
      
      return [...specific.sort(), ...generic].join(', ');
    }
    
    // 6. Join back
    return processedFamilies.join(', ');
  }
}