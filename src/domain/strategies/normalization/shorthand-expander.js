/**
 * SHORTHAND EXPANDER: Expands CSS shorthand properties into their longhand equivalents
 * 
 * Handles:
 * - margin → margin-top/right/bottom/left
 * - padding → padding-top/right/bottom/left
 * - border → border-width/style/color
 * - font → font-size/family/weight/line-height
 * - background → background-color/image (partial)
 */

export class ShorthandExpander {
  //Expand all shorthand properties in CSS object   
  expand(cssObject) {
    const expanded = { ...cssObject };
    
    // Expand margin
    if (expanded.margin && !this._hasLonghand(expanded, 'margin')) {
      const values = this._expandBoxModel(expanded.margin);
      if (values) {
        expanded['margin-top'] = values.top;
        expanded['margin-right'] = values.right;
        expanded['margin-bottom'] = values.bottom;
        expanded['margin-left'] = values.left;
        delete expanded.margin;
      }
    }
    
    // Expand padding
    if (expanded.padding && !this._hasLonghand(expanded, 'padding')) {
      const values = this._expandBoxModel(expanded.padding);
      if (values) {
        expanded['padding-top'] = values.top;
        expanded['padding-right'] = values.right;
        expanded['padding-bottom'] = values.bottom;
        expanded['padding-left'] = values.left;
        delete expanded.padding;
      }
    }
    
    // Expand border (basic - width/style/color)
    if (expanded.border && !this._hasBorderLonghand(expanded)) {
      const parts = this._expandBorder(expanded.border);
      if (parts) {
        if (parts.width) expanded['border-width'] = parts.width;
        if (parts.style) expanded['border-style'] = parts.style;
        if (parts.color) expanded['border-color'] = parts.color;
        delete expanded.border;
      }
    }
    
    // Expand font (complex)
    if (expanded.font && !this._hasFontLonghand(expanded)) {
      const parts = this._expandFont(expanded.font);
      if (parts) {
        if (parts['font-size']) expanded['font-size'] = parts['font-size'];
        if (parts['line-height']) expanded['line-height'] = parts['line-height'];
        if (parts['font-family']) expanded['font-family'] = parts['font-family'];
        if (parts['font-weight']) expanded['font-weight'] = parts['font-weight'];
        if (parts['font-style']) expanded['font-style'] = parts['font-style'];
        delete expanded.font;
      }
    }
    
    // Expand background (partial - color only)
    if (expanded.background && !expanded['background-color']) {
      const color = this._extractBackgroundColor(expanded.background);
      if (color) {
        expanded['background-color'] = color;
        // Keep background for images, gradients
      }
    }
    
    return expanded;
  }
  
  //Check if longhand properties already exist
  _hasLonghand(cssObject, prefix) {
    return cssObject[`${prefix}-top`] || 
           cssObject[`${prefix}-right`] || 
           cssObject[`${prefix}-bottom`] || 
           cssObject[`${prefix}-left`];
  }
  
  _hasBorderLonghand(cssObject) {
    return cssObject['border-width'] || 
           cssObject['border-style'] || 
           cssObject['border-color'];
  }
  
  _hasFontLonghand(cssObject) {
    return cssObject['font-size'] || 
           cssObject['font-family'] || 
           cssObject['font-weight'];
  }
  
  // Expand box model shorthand (margin/padding)
  _expandBoxModel(value) {
    if (!value || typeof value !== 'string') return null;
    
    const parts = value.trim().split(/\s+/);
    
    if (parts.length === 1) {
      return {
        top: parts[0],
        right: parts[0],
        bottom: parts[0],
        left: parts[0]
      };
    }
    
    if (parts.length === 2) {
      return {
        top: parts[0],
        right: parts[1],
        bottom: parts[0],
        left: parts[1]
      };
    }
    
    if (parts.length === 3) {
      return {
        top: parts[0],
        right: parts[1],
        bottom: parts[2],
        left: parts[1]
      };
    }
    
    if (parts.length === 4) {
      return {
        top: parts[0],
        right: parts[1],
        bottom: parts[2],
        left: parts[3]
      };
    }
    
    return null;
  }
  
  // Expand border shorthand
  _expandBorder(value) {
    if (!value || typeof value !== 'string') return null;
    
    const parts = value.trim().split(/\s+/);
    const result = {};
    
    for (const part of parts) {
      if (/^\d+(\.\d+)?(px|em|rem|pt|%)$/.test(part)) {
        result.width = part;
      }
      else if (['none', 'hidden', 'dotted', 'dashed', 'solid', 'double', 'groove', 'ridge', 'inset', 'outset'].includes(part)) {
        result.style = part;
      }
      else {
        result.color = part;
      }
    }
    
    return result;
  }
  
  // Expand font shorthand
  // Format: [style] [variant] [weight] size[/line-height] family
  _expandFont(value) {
    if (!value || typeof value !== 'string') return null;
    
    const trimmed = value.trim();
    const result = {};
    
    const match = trimmed.match(/([\d.]+(?:px|em|rem|pt|%))(\/[\d.]+)?\s+(.+)$/);
    
    if (!match) return null;
    
    result['font-size'] = match[1];
    
    if (match[2]) {
       result['line-height'] = match[2].slice(1);
    }
    
    result['font-family'] = match[3];
    
    const beforeSize = trimmed.substring(0, trimmed.indexOf(match[1])).trim();
    
    if (beforeSize) {
      const tokens = beforeSize.split(/\s+/);
      
      for (const token of tokens) {
        if (['normal', 'bold', 'bolder', 'lighter', '100', '200', '300', '400', '500', '600', '700', '800', '900'].includes(token)) {
          result['font-weight'] = token;
        }
        else if (['normal', 'italic', 'oblique'].includes(token)) {
          result['font-style'] = token;
        }
      }
    }
    
    return result;
  }
  
  // Extract background-color from background shorthand
  _extractBackgroundColor(value) {
    if (!value || typeof value !== 'string') return null;
    
    const trimmed = value.trim();
    
    if (trimmed.includes('url(') || trimmed.includes('gradient(')) {
      return null;
    }
    
    const parts = trimmed.split(/\s+/);
    
    for (const part of parts) {
      if (part.startsWith('#')) {
        return part;
      }
      if (part.startsWith('rgb') || part.startsWith('hsl')) {
        const startIndex = trimmed.indexOf(part);
        const openParen = trimmed.indexOf('(', startIndex);
        let closeParen = openParen;
        let depth = 1;
        
        for (let i = openParen + 1; i < trimmed.length; i++) {
          if (trimmed[i] === '(') depth++;
          if (trimmed[i] === ')') {
            depth--;
            if (depth === 0) {
              closeParen = i;
              break;
            }
          }
        }
        
        return trimmed.substring(startIndex, closeParen + 1);
      }
      if (!/\d/.test(part) && !['top', 'bottom', 'left', 'right', 'center', 'repeat', 'no-repeat'].includes(part)) {
        return part;
      }
    }
    
    return null;
  }
}