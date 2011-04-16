// Convert analyzed data to javascript. Everything has already been calculated
// before this stage, which just does the final conversion to JavaScript.

// Main function
function JSify(data, functionsOnly, givenFunctions, givenGlobalVariables) {
  // Does simple 'macro' substitution, using Django-like syntax,
  // {{{ code }}} will be replaced with |eval(code)|.
  function processMacros(text) {
    return text.replace(/{{{[^}]+}}}/g, function(str) {
      str = str.substr(3, str.length-6);
      return eval(str).toString();
    });
  }

  substrate = new Substrate('JSifyer');

  var GLOBAL_VARIABLES = functionsOnly ? givenGlobalVariables : data.globalVariables;

  Functions.currFunctions = functionsOnly ? givenFunctions : {};
  // Now that analysis has completed, we can get around to handling unparsedFunctions
  (functionsOnly ? data.functions : data.unparsedFunctions.concat(data.functions)).forEach(function(func) {
    // Save just what we need, to save memory - whether there are varargs, and the # of parameters
    Functions.currFunctions[func.ident] = {
      hasVarArgs: func.hasVarArgs,
      numParams: func.params.length
   };
  });

  for (var i = 0; i < data.unparsedFunctions.length; i++) {
    var func = data.unparsedFunctions[i];
    dprint('unparsedFunctions', '====================\n// Processing |' + func.ident + '|, ' + i + '/' + data.unparsedFunctions.length);
    //var t = Date.now();
    func.JS = JSify(analyzer(intertyper(func.lines, true, func.lineNum-1)), true, Functions.currFunctions, GLOBAL_VARIABLES);
    //t = (Date.now()-t)/1000;
    //dprint('unparsedFunctions', 'unparsedFunction took ' + t + ' seconds.');
    delete func.lines; // clean up memory as much as possible
  }

  if (data.unparsedFunctions.length > 0) {
    // We are now doing the final JS generation
    dprint('unparsedFunctions', '== Completed unparsedFunctions ==\n');
    Debugging.clear(); // Save some memory, before the final heavy lifting
  }

  // Actors

  // type
  substrate.addActor('Type', {
    processItem: function(item) {
      var type = Types.types[item.name_];
      var niceName = toNiceIdent(item.name_);
      // We might export all of Types.types, cleaner that way, but do not want slowdowns in accessing flatteners
      item.JS = 'var ' + niceName + '___SIZE = ' + Types.types[item.name_].flatSize + '; // ' + item.name_ + '\n';
      if (type.needsFlattening && !type.flatFactor) {
        item.JS += 'var ' + niceName + '___FLATTENER = ' + JSON.stringify(Types.types[item.name_].flatIndexes) + ';';
      }
      return [item];
    }
  });

  function makeEmptyStruct(type) {
    var ret = [];
    var typeData = Types.types[type];
    assertTrue(typeData);
    for (var i = 0; i < typeData.flatSize; i++) {
      ret.push(0);
    }
    return ret;
  }

  function alignStruct(values, type) {
    var typeData = Types.types[type];
    assertTrue(typeData);
    var ret = [];
    var i = 0, soFar = 0;
    while (i < values.length) {
      // Pad until the right place
      var padded = typeData.flatFactor ? typeData.flatFactor*i : typeData.flatIndexes[i];
      while (soFar < padded) {
        ret.push(0);
        soFar++;
      }
      // Add current value(s)
      var currValue = flatten(values[i]);
      ret.push(currValue);
      i += 1;
      soFar += typeof currValue === 'object' ? currValue.length : 1;
    }
    while (soFar < typeData.flatSize) {
      ret.push(0);
      soFar++;
    }
    return ret;
  }

  // Gets an entire constant expression
  function makeConst(value, type, ident) {
    //dprint('gconst', '//yyyyy ' + JSON.stringify(value) + ',' + type + '\n');
    if (value.intertype) {
      return [finalizeLLVMFunctionCall(value)];
    } else if (Runtime.isNumberType(type) || pointingLevels(type) >= 1) {
      return indexizeFunctions(parseNumerical(toNiceIdent(value.text)));
    } else if (value.text in set('zeroinitializer', 'undef')) { // undef doesn't really need initting, but why not
      return makeEmptyStruct(type);
    } else if (value.text && value.text[0] == '"') {
      value.text = value.text.substr(1, value.text.length-2);
      return JSON.stringify(parseLLVMString(value.text)) +
             ' /* ' + value.text.substr(0, 20).replace(/\*/g, '_') + ' */'; // make string safe for inclusion in comment
    } else {
      // Gets an array of constant items, separated by ',' tokens
      function handleSegments(tokens) {
        //dprint('gconst', '// segggS: ' + JSON.stringify(tokens) + '\n' + '\n')
        // Handle a single segment (after comma separation)
        function handleSegment(segment) {
          //dprint('// seggg: ' + JSON.stringify(segment) + '\n' + '\n')
          if (segment[1].text == 'null') {
            return '0';
          } else if (segment[1].text == 'zeroinitializer') {
            return makeEmptyStruct(segment[0].text);
          } else if (segment[1].text in set('bitcast', 'inttoptr', 'ptrtoint')) { // TODO: Use parse/finalizeLLVMFunctionCall
            var type = segment[2].item.tokens.slice(-1)[0].text; // TODO: Use this?
            return handleSegment(segment[2].item.tokens.slice(0, -2));
          } else if (segment[1].text in PARSABLE_LLVM_FUNCTIONS) {
            return finalizeLLVMFunctionCall(parseLLVMFunctionCall(segment));
          } else if (segment[1].type == '{') {
            // struct
            var type = segment[0].text;
            return alignStruct(handleSegments(segment[1].tokens), type);
          } else if (segment[1].type == '[') {
            var type = segment[0].text;
            return alignStruct(handleSegments(segment[1].item.tokens), type);
          } else if (segment.length == 2) {
            return toNiceIdent(segment[1].text);
          } else if (segment[1].text === 'c') {
            // string
            var text = segment[2].text;
            text = text.substr(1, text.length-2);
            return parseLLVMString(text); // + ' /* ' + text + '*/';
          } else {
            throw 'Invalid segment: ' + dump(segment);
          }
        };
        return splitTokenList(tokens).map(handleSegment).map(indexizeFunctions);
      }
      var contents;
      if (value.item) {
        // list of items
        contents = value.item.tokens;
      } else if (value.type == '{') {
        // struct
        contents = value.tokens;
      } else if (value[0]) {
        contents = value[0];
      } else {
        throw '// failzzzzzzzzzzzzzz ' + dump(value.item) + ' ::: ' + dump(value);
      }
      return alignStruct(handleSegments(contents), type);
    }
  }

  function parseConst(value, type, ident) {
    var constant = makeConst(value, type);
    if (typeof constant === 'object') {
      constant = flatten(constant).map(function(x) { return parseNumerical(x) })
    }
    return constant;
  }

  // globalVariable
  substrate.addActor('GlobalVariable', {
    processItem: function(item) {
      item.intertype = 'GlobalVariableStub';
      delete item.lines; // Save some memory
      var ret = [item];
      if (item.ident == '_llvm_global_ctors') {
        item.JS = '\n__globalConstructor__ = function() {\n' +
                    item.ctors.map(function(ctor) { return '  ' + toNiceIdent(ctor) + '();' }).join('\n') +
                  '\n}\n';
        return ret;
      } else {
        item.JS = 'var ' + item.ident + ';';
        var constant = null;
        if (item.external) {
          return ret;
        } else {
          function needsPostSet(value) {
            return value[0] in set('_', '(') || value.substr(0, 14) === 'CHECK_OVERFLOW';
          }

          constant = parseConst(item.value, item.type, item.ident);
          if (typeof constant === 'string' && constant[0] != '[') {
            constant = [constant]; // A single item. We may need a postset for it.
          }
          if (typeof constant === 'object') {
            // This is a flattened object. We need to find its idents, so they can be assigned to later
            constant.forEach(function(value, i) {
              if (needsPostSet(value)) { // ident, or expression containing an ident
                ret.push({
                  intertype: 'GlobalVariablePostSet',
                  JS: 'IHEAP[' + getFastValue(item.ident, '+', i) + '] = ' + value + ';'
                });
                constant[i] = '0';
              }
            });
            constant = '[' + constant.join(', ') + ']';
          }
          constant = makePointer(constant, null, 'ALLOC_STATIC', item.type);

          return ret.concat({
            intertype: 'GlobalVariable',
            JS: item.ident + '=' + constant + ';',
          });
        }
      }
    }
  });

  var moduleFunctions = set(data.unparsedFunctions.map(function(func) { return func.ident }));

  var addedLibraryItems = {};

  // functionStub
  substrate.addActor('FunctionStub', {
    processItem: function(item) {
      var ret = [item];
      var shortident = item.ident.substr(1);
      if (shortident in Library) {
        function addFromLibrary(ident) {
          var me = arguments.callee;
          if (ident in addedLibraryItems) return '';
          // Don't replace implemented functions with library ones (which can happen when we add dependencies).
          // Note: We don't return the dependencies here. Be careful not to end up where this matters
          if (('_' + ident) in moduleFunctions) return '';

          addedLibraryItems[ident] = true;
          var snippet = Library[ident];
          var redirectedIdent = null;
          if (typeof snippet === 'string') {
            if (Library[snippet]) {
              redirectedIdent = snippet;
              snippet = Library[snippet]; // redirection for aliases
            }
          } else if (typeof snippet === 'object') {
            // JSON.stringify removes functions, so we need to make sure they are added
            var funcs = [];
            for (var x in snippet) {
              if (typeof snippet[x] === 'function') {
                funcs.push(x + ': ' + snippet[x].toString());
              }
            }
            snippet = JSON.stringify(snippet).replace(/}$/, ', ' + funcs.join(', ') + ' }');
          } else if (typeof snippet === 'function') {
            snippet = snippet.toString();
            if (/function ?\(/.exec(snippet)) { // name the function, if not already named
              snippet = snippet.replace('function', 'function _' + ident);
            }
          }

          var postsetId = ident + '__postset';
          var postset = Library[postsetId];
          if (postset && !addedLibraryItems[postsetId]) {
            addedLibraryItems[postsetId] = true;
            ret.push({
              intertype: 'GlobalVariablePostSet',
              JS: postset
            });
          }

          var deps = Library[ident + '__deps'];
          if (redirectedIdent) {
            deps = (deps || []).concat(Library[redirectedIdent + '__deps']);
          }
          return 'var _' + ident + '=' + snippet + (deps ? '\n' + deps.map(addFromLibrary).join('\n') : '');
        }
        item.JS = addFromLibrary(shortident);
      } else {
        item.JS = '// stub for ' + item.ident;
      }
      return ret;
    }
  });

  // function splitter
  substrate.addActor('FunctionSplitter', {
    processItem: function(item) {
      var ret = [item];
      item.splitItems = 0;
      item.labels.forEach(function(label) {
        label.lines.forEach(function(line) {
          line.func = item.ident;
          line.funcData = item;
          line.parentLabel = label.ident;
          ret.push(line);
          item.splitItems ++;
        });
      });

      this.forwardItems(ret, 'FuncLineTriager');
    }
  });

  // function reconstructor & post-JS optimizer
  substrate.addActor('FunctionReconstructor', {
    funcs: {},
    seen: {},
    processItem: function(item) {
      if (this.seen[item.__uid__]) return;
      if (item.intertype == 'function') {
        this.funcs[item.ident] = item;
        item.relines = {};
        this.seen[item.__uid__] = true;
        return;
      }
      var line = item;
      var func = this.funcs[line.func];
      if (!func) return;

      // Re-insert our line
      this.seen[item.__uid__] = true;
      var label = func.labels.filter(function(label) { return label.ident == line.parentLabel })[0];
      label.lines = label.lines.map(function(line2) {
        return (line2.lineNum !== line.lineNum) ? line2 : line;
      });
      func.splitItems --;
      // OLD    delete line.funcData; // clean up
      if (func.splitItems > 0) return;

      // We have this function all reconstructed, go and finalize it's JS!

      func.JS = '\nfunction ' + func.ident + '(' + func.paramIdents.join(', ') + ') {\n';

      func.JS += '  ' + RuntimeGenerator.stackEnter(func.initialStack) + ';\n';

      if (LABEL_DEBUG) func.JS += "  print(INDENT + ' Entering: " + func.ident + "'); INDENT += '  ';\n";

      if (true) { // TODO: optimize away when not needed
        func.JS += '  var __label__;\n';
      }
      if (func.hasPhi) {
        func.JS += '  var __lastLabel__ = null;\n';
      }

      // Walk function blocks and generate JS
      function walkBlock(block, indent) {
        if (!block) return '';
        dprint('relooping', 'walking block: ' + block.type + ',' + block.entries + ' : ' + block.labels.length);
        function getLabelLines(label, indent) {
          if (!label) return '';
          var ret = '';
          if (LABEL_DEBUG) {
            ret += indent + "print(INDENT + '" + func.ident + ":" + label.ident + "');\n";
          }
          if (EXECUTION_TIMEOUT > 0) {
            ret += indent + 'if (Date.now() - START_TIME >= ' + (EXECUTION_TIMEOUT*1000) + ') throw "Timed out!" + (new Error().stack);\n';
          }
          // for special labels we care about (for phi), mark that we visited them
          return ret + label.lines.map(function(line) { return line.JS + (Debugging.on ? Debugging.getComment(line.lineNum) : '') })
                                  .join('\n')
                                  .split('\n') // some lines include line breaks
                                  .map(function(line) { return indent + line })
                                  .join('\n');
        }
        var ret = '';
        if (block.type == 'emulated') {
          if (block.labels.length > 1) {
            if (block.entries.length == 1) {
              ret += indent + '__label__ = ' + getLabelId(block.entries[0]) + '; ' + (SHOW_LABELS ? '/* ' + block.entries[0] + ' */' : '') + '\n';
            } // otherwise, should have been set before!
            ret += indent + 'while(1) switch(__label__) {\n';
            ret += block.labels.map(function(label) {
              return indent + '  case ' + getLabelId(label.ident) + ': // ' + label.ident + '\n'
                            + getLabelLines(label, indent + '    ');
            }).join('\n');
            ret += '\n' + indent + '  default: assert(0, "bad label: " + __label__);\n' + indent + '}';
          } else {
            ret += (SHOW_LABELS ? indent + '/* ' + block.entries[0] + ' */' : '') + '\n' + getLabelLines(block.labels[0], indent);
          }
          ret += '\n';
        } else if (block.type == 'reloop') {
          ret += indent + (block.needBlockId ? block.id + ': ' : '') + 'while(1) { ' + (SHOW_LABELS ? ' /* ' + block.entries + + ' */' : '') + '\n';
          ret += walkBlock(block.inner, indent + '  ');
          ret += indent + '}\n';
        } else if (block.type == 'multiple') {
          var first = true;
          var multipleIdent = '';
          if (!block.loopless) {
            ret += indent + (block.needBlockId ? block.id + ': ' : '') + 'do { \n';
            multipleIdent = '  ';
          }
          var stolen = block.stolenCondition;
          if (stolen) {
            var intendedTrueLabel = stolen.labelTrue;
            assert(block.entryLabels.length <= 2);
            [stolen.labelTrue, stolen.labelFalse].forEach(function(entry) {
              var branch = makeBranch(entry, stolen.currLabelId);
              entryLabel = block.entryLabels.filter(function(possible) { return possible.ident === getActualLabelId(entry) })[0];
              if (branch.length < 5 && !entryLabel) return;
              //ret += indent + multipleIdent + (first ? '' : 'else ') +
              //       'if (' + (entry == intendedTrueLabel ? '' : '!') + stolen.ident + ')' + ' {\n';
              ret += indent + multipleIdent + (first ? 'if (' + (entry == intendedTrueLabel ? '' : '!') + stolen.ident + ')' : 'else') + ' {\n';
              ret += indent + multipleIdent + '  ' + branch + '\n';
              if (entryLabel) {
                ret += walkBlock(entryLabel.block, indent + '  ' + multipleIdent);
              }
              ret += indent + multipleIdent + '}\n';
              first = false;
            });
          } else {
            block.entryLabels.forEach(function(entryLabel) {
              ret += indent + multipleIdent + (first ? '' : 'else ') + 'if (__label__ == ' + getLabelId(entryLabel.ident) + ') {\n';
              ret += walkBlock(entryLabel.block, indent + '  ' + multipleIdent);
              ret += indent + multipleIdent + '}\n';
              first = false;
            });
          }
          if (GUARD_LABELS) {
            ret += indent + multipleIdent + 'else { throw "Bad multiple branching: " + __label__ + " : " + (new Error().stack); }\n';
          }
          if (!block.loopless) {
            ret += indent + '} while(0);\n';
          }
        } else {
          throw "Walked into an invalid block type: " + block.type;
        }
        return ret + walkBlock(block.next, indent);
      }
      func.JS += walkBlock(func.block, '  ');
      // Finalize function
      if (LABEL_DEBUG) func.JS += "  INDENT = INDENT.substr(0, INDENT.length-2);\n";
      // Add an unneeded return, needed for strict mode to not throw warnings in some cases.
      // If we are not relooping, then switches make it unimportant to have this (and, we lack hasReturn anyhow)
      if (RELOOP && func.lines.length > 0 && func.labels.filter(function(label) { return label.hasReturn }).length > 0) {
        func.JS += '  return' + (func.returnType !== 'void' ? ' null' : '') + ';\n';
      }
      func.JS += '}\n';
      if (func.ident in EXPORTED_FUNCTIONS) {
        func.JS += 'Module["' + func.ident + '"] = ' + func.ident + ';';
      }

      return func;
    }
  });

  function getVarData(funcData, ident) {
    return funcData.variables[ident] || GLOBAL_VARIABLES[ident];
  }

  function getVarImpl(funcData, ident) {
    if (ident === 'null') return VAR_NATIVIZED; // like nativized, in that we have the actual value right here
    var data = getVarData(funcData, ident);
    assert(data, 'What variable is this? |' + ident + '|');
    return data.impl;
  }

  substrate.addActor('FuncLineTriager', {
    processItem: function(item) {
      if (item.intertype == 'function') {
        this.forwardItem(item, 'FunctionReconstructor');
      } else if (item.JS) {
        if (item.parentLineNum) {
          this.forwardItem(item, 'AssignReintegrator');
        } else {
          this.forwardItem(item, 'FunctionReconstructor');
        }
      } else {
        this.forwardItem(item, 'Intertype:' + item.intertype);
      }
    }
  });

  // assignment
  substrate.addActor('Intertype:assign', {
    processItem: function(item) {
      var pair = splitItem(item, 'value', ['funcData']);
      this.forwardItem(pair.parent, 'AssignReintegrator');
      this.forwardItem(pair.child, 'FuncLineTriager');
    }
  });
  substrate.addActor('AssignReintegrator', makeReintegrator(function(item, child) {
    // 'var', since this is SSA - first assignment is the only assignment, and where it is defined
    item.JS = (item.overrideSSA ? '' : 'var ') + toNiceIdent(item.ident);

    var type = item.value.type;
    var value = parseNumerical(item.value.JS);
    var impl = getVarImpl(item.funcData, item.ident);
    switch (impl) {
      case VAR_NATIVE: {
        break;
      }
      case VAR_NATIVIZED: {
        // SSA, so this must be the alloca. No need for a value
        if (!item.overrideSSA) value = '';
        break;
      }
      case VAR_EMULATED: {
        break;
      }
      default: throw 'zz unknown impl: ' + impl;
    }
    if (value)
      item.JS += '=' + value;
    item.JS += ';';

    this.forwardItem(item, 'FunctionReconstructor');
  }));

  // Function lines
  function makeFuncLineActor(intertype, func) {
    return substrate.addActor('Intertype:' + intertype, {
      processItem: function(item) {
        item.JS = func(item);
        if (!item.JS) throw "No JS generated for " + dump(item);
        this.forwardItem(item, 'FuncLineTriager');
      }
    });
  }
  makeFuncLineActor('store', function(item) {
    var value = indexizeFunctions(finalizeLLVMParameter(item.value));
    if (pointingLevels(item.pointerType) == 1) {
      value = parseNumerical(value, removePointing(item.pointerType));
    }
    var impl = VAR_EMULATED;
    if (item.pointer.intertype == 'value') {
      impl = getVarImpl(item.funcData, item.ident);
    }
    switch (impl) {
      case VAR_NATIVIZED:
        return item.ident + '=' + value + ';'; // We have the actual value here
        break;
      case VAR_EMULATED:
        if (item.pointer.intertype == 'value') {
          return makeSetValue(item.ident, 0, value, item.valueType);
        } else {
          return makeSetValue(0, indexizeFunctions(finalizeLLVMParameter(item.pointer)), value, item.valueType);
        }
        break;
      default:
        throw 'unknown [store] impl: ' + impl;
    }
  });

  makeFuncLineActor('deleted', function(item) { return ';' });

  var LABEL_IDs = {};
  var LABEL_ID_COUNTER = 0;
  function getLabelId(label) {
    label = label.substr(1);
    if (label === 'entry') return '-1';
    if (label === parseInt(label)) return label; // clang
    //return '"' + label + '"'; // debugging
    label = toNiceIdent(label);
    if (label in LABEL_IDs) return LABEL_IDs[label];
    return LABEL_IDs[label] = LABEL_ID_COUNTER ++;
  }

  function makeBranch(label, lastLabel) {
    var pre = '';
    if (lastLabel) {
      pre = '__lastLabel__ = ' + getLabelId(lastLabel) + '; ';
    }
    if (label[0] == 'B') {
      var parts = label.split('|');
      var trueLabel = parts[1] || '';
      var oldLabel = parts[2] || '';
      var labelSetting = oldLabel ? '__label__ = ' + getLabelId(oldLabel) + ';' +
                         (SHOW_LABELS ? ' /* to: ' + cleanLabel(oldLabel) + ' */' : '') : ''; // TODO: optimize away the setting
      if (label[1] == 'R') {
        return pre + labelSetting + 'break ' + trueLabel + ';';
      } else if (label[1] == 'C') { // CONT
        return pre + labelSetting + 'continue ' + trueLabel + ';';
      } else if (label[1] == 'N') { // NOPP
        return pre + ';'; // Returning no text might confuse this parser
      } else if (label[1] == 'J') { // JSET
        return pre + labelSetting + ';';
      } else {
        throw 'Invalid B-op in branch: ' + trueLabel + ',' + oldLabel;
      }
    } else {
      return pre + '__label__ = ' + getLabelId(label) + ';' + (SHOW_LABELS ? ' /* to: ' + cleanLabel(label) + ' */' : '') + ' break;';
    }
  }

  makeFuncLineActor('branch', function(item) {
    if (item.stolen) return ';'; // We will appear where we were stolen to
    if (!item.ident) {
      return makeBranch(item.label, item.currLabelId);
    } else {
      var labelTrue = makeBranch(item.labelTrue, item.currLabelId);
      var labelFalse = makeBranch(item.labelFalse, item.currLabelId);
      if (labelTrue == ';' && labelFalse == ';') return ';';
      var head = 'if (' + item.ident + ') { ';
      var head2 = 'if (!(' + item.ident + ')) { ';
      var else_ = ' } else { ';
      var tail = ' }';
      if (labelTrue == ';') {
        return head2 + labelFalse + tail;
      } else if (labelFalse == ';') {
        return head + labelTrue + tail;
      } else {
        return head + labelTrue + else_ + labelFalse + tail;
      }
    }
  });
  makeFuncLineActor('switch', function(item) {
    var ret = '';
    var first = true;
    item.switchLabels.forEach(function(switchLabel) {
      if (!first) {
        ret += 'else ';
      } else {
        first = false;
      }
      ret += 'if (' + item.ident + ' == ' + switchLabel.value + ') {\n';
      ret += '  ' + makeBranch(switchLabel.label, item.currLabelId) + '\n';
      ret += '}\n';
    });
    ret += 'else {\n';
    ret += makeBranch(item.defaultLabel, item.currLabelId) + '\n';
    ret += '}\n';
    if (item.value) {
      ret += ' ' + toNiceIdent(item.value);
    }
    return ret;
  });
  makeFuncLineActor('return', function(item) {
    var ret = RuntimeGenerator.stackExit(item.funcData.initialStack) + ';\n';
    if (LABEL_DEBUG) {
      ret += "print(INDENT + 'Exiting: " + item.funcData.ident + "');\n"
          +  "INDENT = INDENT.substr(0, INDENT.length-2);\n";
    }
    ret += 'return';
    if (item.value) {
      ret += ' ' + finalizeLLVMParameter(item.value);
    }
    return ret + ';';
  });
  makeFuncLineActor('invoke', function(item) {
    // Wrapping in a function lets us easily return values if we are
    // in an assignment
    var ret = '(function() { try { __THREW__ = false; return '
            + makeFunctionCall(item.ident, item.params, item.funcData) + ' '
            + '} catch(e) { '
            + 'if (ABORT) throw e; __THREW__ = true; '
            + (EXCEPTION_DEBUG ? 'print("Exception: " + e + " : " + e.stack + ", currently at: " + (new Error().stack)); ' : '')
            + 'return null } })(); if (!__THREW__) { ' + makeBranch(item.toLabel, item.currLabelId)
            + ' } else { ' + makeBranch(item.unwindLabel, item.currLabelId) + ' }';
    return ret;
  });
  makeFuncLineActor('load', function(item) {
    var ident = toNiceIdent(item.ident);
    var impl = getVarImpl(item.funcData, item.ident);
    switch (impl) {
      case VAR_NATIVIZED: {
        return ident; // We have the actual value here
      }
      case VAR_EMULATED: return makeGetValue(ident, null, item.type);
      default: throw "unknown [load] impl: " + impl;
    }
  });
  makeFuncLineActor('extractvalue', function(item) {
    assert(item.indexes.length == 1); // TODO: use getelementptr parsing stuff, for depth. For now, we assume that LLVM aggregates are flat,
                                      //       and we emulate them using simple JS objects { f1: , f2: , } etc., for speed
    return item.ident + '.f' + item.indexes[0][0].text;
  });
  makeFuncLineActor('alloca', function(item) {
    if (typeof item.allocatedIndex === 'number') {
      if (item.allocatedSize === 0) return ''; // This will not actually be shown - it's nativized
      return getFastValue('__stackBase__', '+', item.allocatedIndex.toString());
    } else {
      return RuntimeGenerator.stackAlloc(getFastValue(calcAllocatedSize(item.allocatedType), '*', item.allocatedNum));
    }
  });
  makeFuncLineActor('phi', function(item) {
    var params = item.params;
    function makeOne(i) {
      if (i === params.length-1) {
        return indexizeFunctions(finalizeLLVMParameter(params[i].value));
      }
      return '__lastLabel__ == ' + getLabelId(params[i].label) + ' ? ' +
                                   indexizeFunctions(finalizeLLVMParameter(params[i].value)) + ' : (' + makeOne(i+1) + ')';
    }
    return makeOne(0);
  });

  function makeSignOp(value, type, op) { // TODO: If value isNumber, do this at compile time
    if (!value) return value;
    if (!correctSigns() && !CHECK_SIGNS) return value;
    if (type in Runtime.INT_TYPES) {
      var bits = parseInt(type.substr(1));
      if (isNumber(value)) {
        // Sign/unsign constants at compile time
        return eval(op + 'Sign(' + value + ', ' + bits + ', 1)').toString();
      }
      // shortcuts for 32-bit case
      if (bits === 32 && !CHECK_SIGNS) {
        if (op === 're') {
          return '((' + value + ')|0)';
        } else {
          // TODO: figure out something here along the lines of return '(' + Math.pow(2, 32) + '+((' + value + ')|0))';
        }
      }
      return op + 'Sign(' + value + ', ' + bits + ', ' + Math.floor(correctSpecificSign()) + ')'; // If we are correcting a specific sign here, do not check for it
    } else {
      return value;
    }
  }

  function handleOverflow(text, bits) {
    if (!bits) return text;
    if (bits <= 32 && correctOverflows()) text = '(' + text + ')&' + (Math.pow(2, bits) - 1);
    if (!CHECK_OVERFLOWS || correctSpecificOverflow()) return text; // If we are correcting a specific overflow here, do not check for it
    return 'CHECK_OVERFLOW(' + text + ', ' + bits + ')';
  }

  function makeRounding(value, bits, signed) {
    // C rounds to 0 (-5.5 to -5, +5.5 to 5), while JS has no direct way to do that.
    // With 32 bits and less, and a signed value, |0 will round it like C does.
    if (bits && bits <= 32 && signed) return '('+value+'|0)';
    // If the value may be negative, and we care about proper rounding, then use a slow but correct function
    if (signed && correctRoundings()) return 'cRound(' + value + ')';
    // Either this must be positive, so Math.Floor is correct, or we don't care
    return 'Math.floor(' + value + ')';
  }

  var mathop = makeFuncLineActor('mathop', function(item) { with(item) {
    for (var i = 1; i <= 4; i++) {
      if (item['param'+i]) {
        item['ident'+i] = indexizeFunctions(finalizeLLVMParameter(item['param'+i]));
        if (!isNumber(item['ident'+i])) {
          item['ident'+i] = '(' + item['ident'+i] + ')'; // we may have nested expressions. So enforce the order of operations we want
        }
      } else {
        item['ident'+i] = null; // just so it exists for purposes of reading ident2 etc. later on, and no exception is thrown
      }
    }
    if (op in set('udiv', 'urem', 'uitofp', 'zext', 'lshr') || (variant && variant[0] == 'u')) {
      ident1 = makeSignOp(ident1, type, 'un');
      ident2 = makeSignOp(ident2, type, 'un');
    } else if (op in set('sdiv', 'srem', 'sitofp', 'sext', 'ashr') || (variant && variant[0] == 's')) {
      ident1 = makeSignOp(ident1, type, 're');
      ident2 = makeSignOp(ident2, type, 're');
    }
    var bits = null;
    if (item.type[0] === 'i') {
      bits = parseInt(item.type.substr(1));
    }
    var bitsLeft = ident2 ? ident2.substr(2, ident2.length-3) : null; // remove (i and ), to leave number. This value is important in float ops

    switch (op) {
      // basic integer ops
      case 'add': return handleOverflow(ident1 + ' + ' + ident2, bits);
      case 'sub': return handleOverflow(ident1 + ' - ' + ident2, bits);
      case 'sdiv': case 'udiv': return makeRounding(ident1 + '/' + ident2, bits, op[0] === 's');
      case 'mul': return handleOverflow(ident1 + ' * ' + ident2, bits);
      case 'urem': case 'srem': return ident1 + ' % ' + ident2;
      case 'or': return ident1 + ' | ' + ident2; // TODO this forces into a 32-bit int - add overflow-style checks? also other bitops below us
      case 'and': return ident1 + ' & ' + ident2;
      case 'xor': return ident1 + ' ^ ' + ident2;
      case 'shl': {
        // Note: Increases in size may reach the 32-bit limit... where our sign can flip. But this may be expected by the code...
        /*
        if (bits >= 32) {
          if (CHECK_SIGNS && !CORRECT_SIGNS) return 'shlSignCheck(' + ident1 + ', ' + ident2 + ')';
          if (CORRECT_SIGNS) {
            var mul = 'Math.pow(2, ' + ident2 + ')';
            if (isNumber(ident2)) mul = eval(mul);
            return ident1 + ' * ' + mul;
          }
        }
        */
        return ident1 + ' << ' + ident2;
      }
      case 'ashr': return ident1 + ' >> ' + ident2;
      case 'lshr': return ident1 + ' >>> ' + ident2;
      // basic float ops
      case 'fadd': return ident1 + ' + ' + ident2;
      case 'fsub': return ident1 + ' - ' + ident2;
      case 'fdiv': return ident1 + ' / ' + ident2;
      case 'fmul': return ident1 + ' * ' + ident2;
      case 'uitofp': case 'sitofp': return ident1;
      case 'fptoui': case 'fptosi': return makeRounding(ident1, bitsLeft, op === 'fptosi');

      // TODO: We sometimes generate false instead of 0, etc., in the *cmps. It seemed slightly faster before, but worth rechecking
      //       Note that with typed arrays, these become 0 when written. So that is a potential difference with non-typed array runs.
      case 'icmp': {
        switch (variant) {
          case 'uge': case 'sge': return ident1 + ' >= ' + ident2;
          case 'ule': case 'sle': return ident1 + ' <= ' + ident2;
          case 'ugt': case 'sgt': return ident1 + ' > ' + ident2;
          case 'ult': case 'slt': return ident1 + ' < ' + ident2;
          // We use loose comparisons, which allows false == 0 to be true, etc. Ditto in fcmp
          case 'ne': case 'eq': {
            // We must sign them, so we do not compare -1 to 255 (could have unsigned them both too)
            // since LLVM tells us if <=, >= etc. comparisons are signed, but not == and !=.
            ident1 = makeSignOp(ident1, type, 're');
            ident2 = makeSignOp(ident2, type, 're');
            return ident1 + (variant === 'eq' ? '==' : '!=') + ident2;
          }
          default: throw 'Unknown icmp variant: ' + variant;
        }
      }
      case 'fcmp': {
        switch (variant) {
          // TODO 'o' ones should be 'ordered (no NaN) and',
          //      'u' ones should be 'unordered or'.
          case 'uge': case 'oge': return ident1 + ' >= ' + ident2;
          case 'ule': case 'ole': return ident1 + ' <= ' + ident2;
          case 'ugt': case 'ogt': return ident1 + ' > ' + ident2;
          case 'ult': case 'olt': return ident1 + ' < ' + ident2;
          case 'une': case 'one': return ident1 + ' != ' + ident2;
          case 'ueq': case 'oeq': return ident1 + ' == ' + ident2;
          case 'ord': return '!isNaN(' + ident1 + ') && !isNaN(' + ident2 + ')';
          case 'uno': return 'isNaN(' + ident1 + ') || isNaN(' + ident2 + ')';
          case 'true': return '1';
          default: throw 'Unknown fcmp variant: ' + variant;
        }
      }
      // Note that zext has sign checking, see above. We must guard against -33 in i8 turning into -33 in i32
      // then unsigning that i32... which would give something huge.
      case 'zext': case 'fpext': case 'sext': return ident1;
      case 'fptrunc': return ident1;
      case 'trunc': {
        // Unlike extending, which we just 'do' (by doing nothing),
        // truncating can change the number, e.g. by truncating to an i1
        // in order to get the first bit
        assert(ident2[1] == 'i');
        assert(bitsLeft <= 32, 'Cannot truncate to more than 32 bits, since we use a native & op');
        return '((' + ident1 + ') & ' + (Math.pow(2, bitsLeft)-1) + ')';
      }
      case 'select': return ident1 + ' ? ' + ident2 + ' : ' + ident3;
      case 'ptrtoint': return ident1;
      case 'inttoptr': return ident1;
      default: throw 'Unknown mathcmp op: ' + item.op;
    }
  } });

  function getGetElementPtrIndexes(item) {
    var ident = item.ident;
    var type = item.params[0].type; // param 0 == type
    // struct pointer, struct*, and getting a ptr to an element in that struct. Param 1 is which struct, then we have items in that
    // struct, and possibly further substructures, all embedded
    // can also be to 'blocks': [8 x i32]*, not just structs
    type = removePointing(type);
    var indexes = [makeGetPos(ident)];
    var offset = toNiceIdent(item.params[1].ident);
    if (offset != 0) {
      if (isStructType(type)) {
        indexes.push(getFastValue(Types.types[type].flatSize, '*', offset));
      } else {
        indexes.push(getFastValue(getNativeFieldSize(type, true), '*', offset));
      }
    }
    item.params.slice(2, item.params.length).forEach(function(arg) {
      dprint('types', 'GEP type: ' + type);
      var curr = toNiceIdent(arg.ident);
      // TODO: If index is constant, optimize
      var typeData = Types.types[type];
      if (isStructType(type) && typeData.needsFlattening) {
        if (typeData.flatFactor) {
          indexes.push(getFastValue(curr, '*', typeData.flatFactor));
        } else {
          if (isNumber(curr)) {
            indexes.push(typeData.flatIndexes[curr]);
          } else {
            indexes.push(toNiceIdent(type) + '___FLATTENER[' + curr + ']'); // TODO: If curr is constant, optimize out the flattener struct
          }
        }
      } else {
        if (curr != 0) {
          indexes.push(curr);
        }
      }
      if (!isNumber(curr) || parseInt(curr) < 0) {
        // We have a *variable* to index with, or a negative number. In both
        // cases, in theory we might need to do something dynamic here. FIXME?
        // But, most likely all the possible types are the same, so do that case here now...
        for (var i = 1; i < typeData.fields.length; i++) {
          assert(typeData.fields[0] === typeData.fields[i]);
        }
        curr = 0;
      }
      type = typeData ? typeData.fields[curr] : '';
    });
    var ret = indexes[0];
    for (var i = 1; i < indexes.length; i++) {
      ret = getFastValue(ret, '+', indexes[i]);
    }

    ret = handleOverflow(ret, 32); // XXX - we assume a 32-bit arch here. If you fail on this, change to 64

    return ret;
  }

  function finalizeLLVMFunctionCall(item) {
    switch(item.intertype) {
      case 'getelementptr': // TODO finalizeLLVMParameter on the ident and the indexes?
        return makePointer(makeGetSlabs(item.ident, item.type)[0], getGetElementPtrIndexes(item), null, item.type);
      case 'bitcast':
      case 'inttoptr':
      case 'ptrtoint':
        return finalizeLLVMParameter(item.params[0]);
      case 'icmp': case 'mul': case 'zext': case 'add': case 'sub': case 'div':
        var temp = {
          op: item.intertype,
          variant: item.variant,
          type: item.type
        };
        for (var i = 1; i <= 4; i++) {
          if (item.params[i-1]) {
            temp['param' + i] = finalizeLLVMParameter(item.params[i-1]);
          }
        }
        mathop.processItem(temp);
        return temp.JS;
      default:
        throw 'Invalid function to finalize: ' + dump(item.intertype);
    }
  }

  // From parseLLVMSegment
  function finalizeLLVMParameter(param) {
    if (isNumber(param)) {
      return param;
    } else if (typeof param === 'string') {
      return toNiceIdentCarefully(param);
    } else if (param.intertype in PARSABLE_LLVM_FUNCTIONS) {
      return finalizeLLVMFunctionCall(param);
    } else if (param.intertype == 'value') {
      return parseNumerical(param.ident);
    } else if (param.intertype == 'structvalue') {
      return param.values.map(finalizeLLVMParameter);
    } else {
      throw 'invalid llvm parameter: ' + param.intertype;
    }
  }

  makeFuncLineActor('bitcast', function(item) {
    var ident = toNiceIdent(item.ident);
    return ident;
  });

  function makeFunctionCall(ident, params, funcData) {
    // We cannot compile assembly. See comment in intertyper.js:'Call'
    assert(ident != 'asm', 'Inline assembly cannot be compiled to JavaScript!');

    // Special cases
    if (ident == '_llvm_va_start') {
      // varargs - we received a pointer to the varargs as a final 'extra' parameter
      var data = 'arguments[' + Framework.currItem.funcData.ident + '.length]';
      if (SAFE_HEAP) {
        return 'SAFE_HEAP_STORE(' + params[0].ident + ', ' + data + ', null)';
      } else {
        return 'IHEAP[' + params[0].ident + '] = ' + data;
      }
    } else if (ident == '_llvm_va_end') {
      return ';';
    }

    var func = Functions.currFunctions[ident];
    var args = [];
    var varargs = [];

    params.forEach(function(param, i) {
      var val;
      if (param.intertype in PARSABLE_LLVM_FUNCTIONS) {
        val = finalizeLLVMFunctionCall(param);
      } else {
        val = toNiceIdent(param.ident);
      }
      if (!func || !func.hasVarArgs || i < func.numParams-1) { // unrecognized functions (like library ones) cannot have varargs
        args.push(val);
      } else {
        varargs.push(val);
        varargs = varargs.concat(zeros(getNativeFieldSize(param.type)-1));
      }
    });

    args = args.map(indexizeFunctions);
    varargs = varargs.map(indexizeFunctions);
    if (varargs.length > 0) {
      varargs = makePointer('[' + varargs + ']', 0, 'ALLOC_STACK');
    }

    if (getVarData(funcData, ident)) {
      ident = 'FUNCTION_TABLE[' + ident + ']';
    }

    return ident + '(' + args.concat(varargs).join(', ') + ')';
  }
  makeFuncLineActor('getelementptr', function(item) { return finalizeLLVMFunctionCall(item) });
  makeFuncLineActor('call', function(item) {
    return makeFunctionCall(item.ident, item.params, item.funcData) + (item.standalone ? ';' : '');
  });

  // Optimized intertypes

  makeFuncLineActor('fastgetelementptrload', function(item) {
    return 'var ' + item.ident + '=' + makeGetValue(parseNumerical(item.value.ident), getGetElementPtrIndexes(item.value), item.value.valueType, true) + ';';
  });
  makeFuncLineActor('fastgetelementptrstore', function(item) {
    return makeSetValue(item.value.ident, getGetElementPtrIndexes(item.value), parseNumerical(item.ident), item.type, true) + ';';
  });

  makeFuncLineActor('unreachable', function(item) { return 'throw "Reached an unreachable! Original .ll line: ' + item.lineNum + '";' });

  // Final combiner

  function finalCombiner(items) {
    dprint('unparsedFunctions', 'Starting finalCombiner');
    var itemsDict = { type: [], GlobalVariableStub: [], functionStub: [], function: [], GlobalVariable: [], GlobalVariablePostSet: [] };
    items.forEach(function(item) {
      item.lines = null;
      var small = { intertype: item.intertype, JS: item.JS }; // Release memory
      itemsDict[small.intertype].push(small);
    });
    items = null;

    var generated = [];
    if (!functionsOnly) {
      generated = generated.concat(itemsDict.type).concat(itemsDict.GlobalVariableStub).concat(itemsDict.functionStub);
    }
    generated = generated.concat(itemsDict.function).concat(data.unparsedFunctions);

    if (functionsOnly) return generated.map(function(item) { return item.JS }).join('\n');

    // We are ready to print out the data, but must do so carefully - we are
    // dealing with potentially *huge* strings. Convenient replacements and
    // manipulations may create in-memory copies, and we may OOM.
    //
    // Final shape that we now create:
    //    shell
    //      (body)
    //        preamble
    //          runtime
    //        generated code
    //        postamble
    //          global_vars

    var shellParts = read('shell.node.js').split('{{BODY}}');
    print(shellParts[0]);
      var pre = processMacros(preprocess(read('preamble.js').replace('{{RUNTIME}}', getRuntime()), CONSTANTS));
      print(pre);
      generated.forEach(function(item) { print(indentify(item.JS || '', 2)); });
      print(Functions.generateIndexing());

      var postParts = processMacros(preprocess(read('postamble.js'), CONSTANTS)).split('{{GLOBAL_VARS}}');
      print(postParts[0]);
        itemsDict.GlobalVariable.forEach(function(item) { print(indentify(item.JS, 4)); });
        itemsDict.GlobalVariablePostSet.forEach(function(item) { print(indentify(item.JS, 4)); });
      print(postParts[1]);
    print(shellParts[1]);
  }

  // Data

  substrate.addItems(values(Types.types).filter(function(type) { return type.lineNum != '?' }), 'Type');
  substrate.addItems(values(data.globalVariables), 'GlobalVariable');
  substrate.addItems(data.functions, 'FunctionSplitter');
  substrate.addItems(data.functionStubs, 'FunctionStub');

  return finalCombiner(substrate.solve());
}

