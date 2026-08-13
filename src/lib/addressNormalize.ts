/** US state/territory full name (lowercase) → 2-letter USPS code */
const STATE_NAME_TO_CODE: Record<string, string> = {
  alabama: 'AL',
  alaska: 'AK',
  'american samoa': 'AS',
  arizona: 'AZ',
  arkansas: 'AR',
  california: 'CA',
  colorado: 'CO',
  connecticut: 'CT',
  delaware: 'DE',
  'district of columbia': 'DC',
  'd.c.': 'DC',
  dc: 'DC',
  florida: 'FL',
  georgia: 'GA',
  guam: 'GU',
  hawaii: 'HI',
  idaho: 'ID',
  illinois: 'IL',
  indiana: 'IN',
  iowa: 'IA',
  kansas: 'KS',
  kentucky: 'KY',
  louisiana: 'LA',
  maine: 'ME',
  maryland: 'MD',
  massachusetts: 'MA',
  mass: 'MA',
  michigan: 'MI',
  minnesota: 'MN',
  mississippi: 'MS',
  missouri: 'MO',
  montana: 'MT',
  nebraska: 'NE',
  nevada: 'NV',
  'new hampshire': 'NH',
  'new jersey': 'NJ',
  'new mexico': 'NM',
  'new york': 'NY',
  'north carolina': 'NC',
  'north dakota': 'ND',
  'northern mariana islands': 'MP',
  ohio: 'OH',
  oklahoma: 'OK',
  oregon: 'OR',
  pennsylvania: 'PA',
  penn: 'PA',
  'puerto rico': 'PR',
  'rhode island': 'RI',
  'south carolina': 'SC',
  'south dakota': 'SD',
  tennessee: 'TN',
  texas: 'TX',
  utah: 'UT',
  vermont: 'VT',
  virginia: 'VA',
  'u.s. virgin islands': 'VI',
  'us virgin islands': 'VI',
  'virgin islands': 'VI',
  washington: 'WA',
  'west virginia': 'WV',
  wisconsin: 'WI',
  wyoming: 'WY',
};

export function normalizeState(input: string): string {
  const trimmed = input.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (STATE_NAME_TO_CODE[lower]) return STATE_NAME_TO_CODE[lower];
  if (trimmed.length === 2) return trimmed.toUpperCase();
  return trimmed;
}

export function normalizeZip(input: string): string {
  const digits = (input || '').replace(/\D/g, '');
  return digits.slice(0, 5);
}
