import { normalizeValue, shareable } from './values.js';

describe('values from a Partner', () => {
  it('normalises the way the Agent does', () => {
    // The Agent's clean.Normalize gives the same keys (clean_test.go).
    expect(normalizeValue(' Credit-Card ')).toBe('credit card');
    expect(normalizeValue('credit_card')).toBe('credit card');
    expect(normalizeValue('Home & Kitchen')).toBe('home and kitchen');
    expect(normalizeValue("Men's  Wear")).toBe('mens wear');
    expect(normalizeValue('U.P.')).toBe('u p');
    expect(normalizeValue('गुरुग्राम')).toBe('गुरुग्राम');
  });

  it('lets only short phrases leave the Partner', () => {
    for (const v of ['Running shoes', 'Kurtis', 'Bengaluru Urban', 'गुरुग्राम', 'Tier 2']) {
      expect(shareable(v)).toBe(true);
    }
    for (const v of [
      'asha@example.com', // an address
      '+91 98765 43210', // a phone number
      '400001', // a pincode, or an ID
      '12345',
      '',
      '-',
      'a'.repeat(81),
      'please call me back after six in the evening on weekdays', // a sentence
    ]) {
      expect(shareable(v)).toBe(false);
    }
  });
});
