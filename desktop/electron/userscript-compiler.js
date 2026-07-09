function compileUserscriptForElectron(source) {
  let compiled = inlineUserscriptEvalBlock(source, 'DM_BRIDGE_CODE');
  compiled = inlineUserscriptEvalBlock(compiled, 'BRIDGE_CODE');
  return `${compiled}\n//# sourceURL=vulcan-douyin-userscript.user.js`;
}

function inlineUserscriptEvalBlock(source, variableName) {
  const startMarker = `  var ${variableName} = (function`;
  const evalMarker = `  unsafeWindow.eval(${variableName});`;
  const start = source.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`Unable to find ${variableName} declaration in douyin.user.js`);
  }
  const evalStart = source.indexOf(evalMarker, start);
  if (evalStart === -1) {
    throw new Error(`Unable to find unsafeWindow.eval(${variableName}) in douyin.user.js`);
  }
  const evalEnd = source.indexOf('\n', evalStart);
  const replaceEnd = evalEnd === -1 ? evalStart + evalMarker.length : evalEnd + 1;
  const block = indentUserscriptBlock(extractUserscriptBlock(source, variableName), '  ');
  return `${source.slice(0, start)}  // Vulcan Mini Tampermonkey: inlined ${variableName} to avoid page eval/CSP issues.\n${block}\n${source.slice(replaceEnd)}`;
}

function indentUserscriptBlock(block, indent) {
  return String(block)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line ? `${indent}${line}` : ''))
    .join('\n');
}

function extractUserscriptBlock(source, variableName) {
  const declaration = `var ${variableName} = (function`;
  const declarationStart = source.indexOf(declaration);
  if (declarationStart === -1) {
    throw new Error(`Unable to find ${variableName} declaration in douyin.user.js`);
  }
  const bodyStartMarker = '{/*';
  const bodyStart = source.indexOf(bodyStartMarker, declarationStart);
  if (bodyStart === -1) {
    throw new Error(`Unable to find ${variableName} body start in douyin.user.js`);
  }
  const bodyEndMarker = '*/}).toString().match';
  const bodyEnd = source.indexOf(bodyEndMarker, bodyStart + bodyStartMarker.length);
  if (bodyEnd === -1) {
    throw new Error(`Unable to find ${variableName} body end in douyin.user.js`);
  }
  return source.slice(bodyStart + bodyStartMarker.length, bodyEnd);
}

module.exports = {
  compileUserscriptForElectron,
  extractUserscriptBlock,
  inlineUserscriptEvalBlock,
};

