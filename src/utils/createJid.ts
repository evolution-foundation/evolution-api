// Check if the number is MX or AR
function formatMXOrARNumber(jid: string): string {
  const countryCode = jid.substring(0, 2);

  if (Number(countryCode) === 52 || Number(countryCode) === 54) {
    if (jid.length === 13) {
      const number = countryCode + jid.substring(3);
      return number;
    }

    return jid;
  }
  return jid;
}

// Check if the number is br
function formatBRNumber(jid: string) {
  const regexp = new RegExp(/^(\d{2})(\d{2})\d{1}(\d{8})$/);
  if (regexp.test(jid)) {
    const match = regexp.exec(jid);
    if (match && match[1] === '55') {
      const joker = Number.parseInt(match[3][0]);
      const ddd = Number.parseInt(match[2]);
      if (joker < 7 || ddd < 31) {
        return match[0];
      }
      return match[1] + match[2] + match[3];
    }
    return jid;
  } else {
    return jid;
  }
}

export function createJid(number: string): string {
  number = number.replace(/:\d+/, '');

  if (
    number.includes('@g.us') ||
    number.includes('@s.whatsapp.net') ||
    number.includes('@lid') ||
    number.includes('@newsletter')
  ) {
    return number;
  }

  if (number.includes('@broadcast')) {
    return number;
  }

  number = number
    ?.replace(/\s/g, '')
    .replace(/\+/g, '')
    .replace(/\(/g, '')
    .replace(/\)/g, '')
    .split(':')[0]
    .split('@')[0];

  if (number.includes('-') && number.length >= 24) {
    number = number.replace(/[^\d-]/g, '');
    return `${number}@g.us`;
  }

  number = number.replace(/\D/g, '');

  if (number.length >= 18) {
    number = number.replace(/[^\d-]/g, '');
    return `${number}@g.us`;
  }

  number = formatMXOrARNumber(number);

  number = formatBRNumber(number);

  return `${number}@s.whatsapp.net`;
}
