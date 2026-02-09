/**
 * COLOR NORMALIZER
 * Converts all color formats to canonical rgba(r, g, b, a)
 *
 * Handles:
 * - Named: "red" → "rgba(255, 0, 0, 1)"
 * - Hex: "#FF0000", "#F00" → "rgba(255, 0, 0, 1)"
 * - RGB/RGBA: standardizes spacing
 * - HSL/HSLA: converts to RGBA
 * - Special: transparent, currentColor, inherit
 */

import logger from '../../../infrastructure/logger.js';

export class ColorNormalizer {
  constructor() {
    this._namedColors = null;
  }
  
  normalize(color) {
    try {
      if (!color || typeof color !== 'string') return color;

      const trimmed = color.trim().toLowerCase();

      // 1. Special values (pass through)
      if (['currentcolor', 'inherit', 'initial', 'unset', 'revert'].includes(trimmed)) {
        return trimmed;
      }

      // 2. Transparent
      if (trimmed === 'transparent') {
        return 'rgba(0, 0, 0, 0)';
      }

      // 3. Named colors
      if (this._isNamedColor(trimmed)) {
        return this._namedToRgba(trimmed);
      }

      // 4. Hex
      if (trimmed.startsWith('#')) {
        return this._hexToRgba(trimmed);
      }

      // 5. RGB/RGBA (already correct format, just standardize)
      if (trimmed.startsWith('rgb')) {
        return this._standardizeRgba(trimmed);
      }

      // 6. HSL/HSLA
      if (trimmed.startsWith('hsl')) {
        return this._hslToRgba(trimmed);
      }

      // Unknown format
      return color;
    } catch (error) {
      logger.warn('Color normalization failed', {
        color,
        error: error.message
      });
      return color; // Return original on error
    }
  }
  
  _hexToRgba(hex) {
    let h = hex.slice(1);
    
    // Validate hex characters
    if (!/^[0-9A-Fa-f]{3,8}$/.test(h)) {
      return hex; // Return original if invalid
    }
    
    // Expand shorthand
    if (h.length === 3) {
      h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    
    // Validate parsed values
    if (isNaN(r) || isNaN(g) || isNaN(b)) {
      return hex; // Return original if parsing fails
    }
    
    const a = h.length === 8 
    
      ? (parseInt(h.slice(6, 8), 16) / 255).toFixed(2)
      : '1';
    
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  
  _hslToRgba(hsl) {
    const match = hsl.match(/hsla?\((\d+),\s*(\d+)%,\s*(\d+)%(?:,\s*([\d.]+))?\)/);
    if (!match) return hsl;

    let h = parseInt(match[1]);
    let s = parseInt(match[2]);
    let l = parseInt(match[3]);
    const alpha = match[4] ? parseFloat(match[4]) : 1;

    // Validate ranges
    if (isNaN(h) || isNaN(s) || isNaN(l) || isNaN(alpha)) {
      return hsl;
    }

    // Normalize out-of-range values
    h = ((h % 360) + 360) % 360; // Handle negative, wrap to 0-359
    s = Math.max(0, Math.min(100, s)); // Clamp to 0-100
    l = Math.max(0, Math.min(100, l)); // Clamp to 0-100

    // Convert to 0-1 range
    h = h / 360;
    s = s / 100;
    l = l / 100;

    let r, g, b;
    
    if (s === 0) {
      r = g = b = l;
    } else {
      const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1/6) return p + (q - p) * 6 * t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
        return p;
      };
      
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      
      r = hue2rgb(p, q, h + 1/3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1/3);
    }
    
    r = Math.round(r * 255);
    g = Math.round(g * 255);
    b = Math.round(b * 255);
    
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  
  _standardizeRgba(rgba) {
    const match = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (!match) return rgba;
    
    const r = parseInt(match[1]);
    const g = parseInt(match[2]);
    const b = parseInt(match[3]);
    const a = match[4] ? parseFloat(match[4]) : 1;
    
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  
  _isNamedColor(color) {
    if (!this._namedColors) {
      this._namedColors = this._getNamedColors();
    }
    return this._namedColors.has(color);
  }
  
  _namedToRgba(color) {
    if (!this._namedColors) {
      this._namedColors = this._getNamedColors();
    }
    const hex = this._namedColors.get(color);
    return hex ? this._hexToRgba(hex) : color;
  }
  
  _getNamedColors() {
    return new Map([
      ['aliceblue', '#F0F8FF'],
      ['antiquewhite', '#FAEBD7'],
      ['aqua', '#00FFFF'],
      ['aquamarine', '#7FFFD4'],
      ['azure', '#F0FFFF'],
      ['beige', '#F5F5DC'],
      ['bisque', '#FFE4C4'],
      ['black', '#000000'],
      ['blanchedalmond', '#FFEBCD'],
      ['blue', '#0000FF'],
      ['blueviolet', '#8A2BE2'],
      ['brown', '#A52A2A'],
      ['burlywood', '#DEB887'],
      ['cadetblue', '#5F9EA0'],
      ['chartreuse', '#7FFF00'],
      ['chocolate', '#D2691E'],
      ['coral', '#FF7F50'],
      ['cornflowerblue', '#6495ED'],
      ['cornsilk', '#FFF8DC'],
      ['crimson', '#DC143C'],
      ['cyan', '#00FFFF'],
      ['darkblue', '#00008B'],
      ['darkcyan', '#008B8B'],
      ['darkgoldenrod', '#B8860B'],
      ['darkgray', '#A9A9A9'],
      ['darkgrey', '#A9A9A9'],
      ['darkgreen', '#006400'],
      ['darkkhaki', '#BDB76B'],
      ['darkmagenta', '#8B008B'],
      ['darkolivegreen', '#556B2F'],
      ['darkorange', '#FF8C00'],
      ['darkorchid', '#9932CC'],
      ['darkred', '#8B0000'],
      ['darksalmon', '#E9967A'],
      ['darkseagreen', '#8FBC8F'],
      ['darkslateblue', '#483D8B'],
      ['darkslategray', '#2F4F4F'],
      ['darkslategrey', '#2F4F4F'],
      ['darkturquoise', '#00CED1'],
      ['darkviolet', '#9400D3'],
      ['deeppink', '#FF1493'],
      ['deepskyblue', '#00BFFF'],
      ['dimgray', '#696969'],
      ['dimgrey', '#696969'],
      ['dodgerblue', '#1E90FF'],
      ['firebrick', '#B22222'],
      ['floralwhite', '#FFFAF0'],
      ['forestgreen', '#228B22'],
      ['fuchsia', '#FF00FF'],
      ['gainsboro', '#DCDCDC'],
      ['ghostwhite', '#F8F8FF'],
      ['gold', '#FFD700'],
      ['goldenrod', '#DAA520'],
      ['gray', '#808080'],
      ['grey', '#808080'],
      ['green', '#008000'],
      ['greenyellow', '#ADFF2F'],
      ['honeydew', '#F0FFF0'],
      ['hotpink', '#FF69B4'],
      ['indianred', '#CD5C5C'],
      ['indigo', '#4B0082'],
      ['ivory', '#FFFFF0'],
      ['khaki', '#F0E68C'],
      ['lavender', '#E6E6FA'],
      ['lavenderblush', '#FFF0F5'],
      ['lawngreen', '#7CFC00'],
      ['lemonchiffon', '#FFFACD'],
      ['lightblue', '#ADD8E6'],
      ['lightcoral', '#F08080'],
      ['lightcyan', '#E0FFFF'],
      ['lightgoldenrodyellow', '#FAFAD2'],
      ['lightgray', '#D3D3D3'],
      ['lightgrey', '#D3D3D3'],
      ['lightgreen', '#90EE90'],
      ['lightpink', '#FFB6C1'],
      ['lightsalmon', '#FFA07A'],
      ['lightseagreen', '#20B2AA'],
      ['lightskyblue', '#87CEFA'],
      ['lightslategray', '#778899'],
      ['lightslategrey', '#778899'],
      ['lightsteelblue', '#B0C4DE'],
      ['lightyellow', '#FFFFE0'],
      ['lime', '#00FF00'],
      ['limegreen', '#32CD32'],
      ['linen', '#FAF0E6'],
      ['magenta', '#FF00FF'],
      ['maroon', '#800000'],
      ['mediumaquamarine', '#66CDAA'],
      ['mediumblue', '#0000CD'],
      ['mediumorchid', '#BA55D3'],
      ['mediumpurple', '#9370DB'],
      ['mediumseagreen', '#3CB371'],
      ['mediumslateblue', '#7B68EE'],
      ['mediumspringgreen', '#00FA9A'],
      ['mediumturquoise', '#48D1CC'],
      ['mediumvioletred', '#C71585'],
      ['midnightblue', '#191970'],
      ['mintcream', '#F5FFFA'],
      ['mistyrose', '#FFE4E1'],
      ['moccasin', '#FFE4B5'],
      ['navajowhite', '#FFDEAD'],
      ['navy', '#000080'],
      ['oldlace', '#FDF5E6'],
      ['olive', '#808000'],
      ['olivedrab', '#6B8E23'],
      ['orange', '#FFA500'],
      ['orangered', '#FF4500'],
      ['orchid', '#DA70D6'],
      ['palegoldenrod', '#EEE8AA'],
      ['palegreen', '#98FB98'],
      ['paleturquoise', '#AFEEEE'],
      ['palevioletred', '#DB7093'],
      ['papayawhip', '#FFEFD5'],
      ['peachpuff', '#FFDAB9'],
      ['peru', '#CD853F'],
      ['pink', '#FFC0CB'],
      ['plum', '#DDA0DD'],
      ['powderblue', '#B0E0E6'],
      ['purple', '#800080'],
      ['rebeccapurple', '#663399'],
      ['red', '#FF0000'],
      ['rosybrown', '#BC8F8F'],
      ['royalblue', '#4169E1'],
      ['saddlebrown', '#8B4513'],
      ['salmon', '#FA8072'],
      ['sandybrown', '#F4A460'],
      ['seagreen', '#2E8B57'],
      ['seashell', '#FFF5EE'],
      ['sienna', '#A0522D'],
      ['silver', '#C0C0C0'],
      ['skyblue', '#87CEEB'],
      ['slateblue', '#6A5ACD'],
      ['slategray', '#708090'],
      ['slategrey', '#708090'],
      ['snow', '#FFFAFA'],
      ['springgreen', '#00FF7F'],
      ['steelblue', '#4682B4'],
      ['tan', '#D2B48C'],
      ['teal', '#008080'],
      ['thistle', '#D8BFD8'],
      ['tomato', '#FF6347'],
      ['turquoise', '#40E0D0'],
      ['violet', '#EE82EE'],
      ['wheat', '#F5DEB3'],
      ['white', '#FFFFFF'],
      ['whitesmoke', '#F5F5F5'],
      ['yellow', '#FFFF00'],
      ['yellowgreen', '#9ACD32']
    ]);
  }
}