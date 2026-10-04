class Report {
  constructor() {
    this.failures = [];
    this.checks = 0;
  }

  expect(label, actual, expected) {
    this.checks += 1;
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    const line = `${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` -> got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`;
    console.log(`  ${line}`);
    if (!ok) {
      this.failures.push(label);
    }
    return ok;
  }

  expectAtLeast(label, actual, minimum) {
    this.checks += 1;
    const ok = Number(actual) >= minimum;
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` -> got ${actual}, want >= ${minimum}`}`);
    if (!ok) {
      this.failures.push(label);
    }
    return ok;
  }

  finish(suiteName) {
    console.log(`\n${suiteName}: ${this.checks - this.failures.length}/${this.checks} checks passed`);
    if (this.failures.length > 0) {
      console.log(`FAILED: ${this.failures.join(', ')}`);
      process.exitCode = 1;
      return false;
    }
    console.log('OK');
    return true;
  }
}

module.exports = { Report };