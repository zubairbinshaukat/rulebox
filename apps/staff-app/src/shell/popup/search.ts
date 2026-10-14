/** Case-fold and strip common Latin diacritics so "Café" matches "cafe". */
export function foldSearch(text: string): string {
  let out = "";
  for (const raw of text) {
    for (const lower of raw.toLowerCase()) {
      switch (lower) {
        case "à":
        case "á":
        case "â":
        case "ã":
        case "ä":
        case "å":
        case "ā":
        case "ă":
        case "ą":
          out += "a";
          break;
        case "æ":
          out += "ae";
          break;
        case "ç":
        case "ć":
        case "č":
        case "ĉ":
        case "ċ":
          out += "c";
          break;
        case "ď":
        case "đ":
          out += "d";
          break;
        case "è":
        case "é":
        case "ê":
        case "ë":
        case "ē":
        case "ĕ":
        case "ė":
        case "ę":
        case "ě":
          out += "e";
          break;
        case "ì":
        case "í":
        case "î":
        case "ï":
        case "ī":
        case "ĭ":
        case "į":
        case "ı":
          out += "i";
          break;
        case "ñ":
        case "ń":
        case "ň":
        case "ņ":
          out += "n";
          break;
        case "ò":
        case "ó":
        case "ô":
        case "õ":
        case "ö":
        case "ø":
        case "ō":
        case "ŏ":
        case "ő":
          out += "o";
          break;
        case "œ":
          out += "oe";
          break;
        case "ù":
        case "ú":
        case "û":
        case "ü":
        case "ū":
        case "ŭ":
        case "ů":
        case "ű":
        case "ų":
          out += "u";
          break;
        case "ý":
        case "ÿ":
        case "ŷ":
          out += "y";
          break;
        case "ß":
          out += "ss";
          break;
        case "ž":
        case "ź":
        case "ż":
          out += "z";
          break;
        case "š":
        case "ś":
        case "ş":
          out += "s";
          break;
        case "ğ":
          out += "g";
          break;
        case "ł":
          out += "l";
          break;
        default:
          out += lower;
      }
    }
  }
  return out;
}

/** `name` contains `query`, ignoring case and diacritics. An empty query matches. */
export function matchesSearch(name: string, query: string): boolean {
  const folded = foldSearch(query.trim());
  return folded.length === 0 || foldSearch(name).includes(folded);
}
