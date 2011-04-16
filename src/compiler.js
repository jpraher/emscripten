// LLVM => JavaScript compiler, main entry point

try {
  // On SpiderMonkey, prepare a large amount of GC space
  gcparam('maxBytes', 1024*1024*1024);
} catch(e) {}

// Prep - allow this to run in both SpiderMonkey and V8
var stdin;
if (require) {
  // we are in Node.js
  snarf = function(filename) { return require('fs').readFileSync(filename, 'utf8'); };
  print = console.log;
  stdin = process.openStdin();
}

if (!this['load']) {
  load = function(f) { eval(snarf(f)) };
}
if (!this['read']) {
  read = function(f) { return snarf(f) };
}

// Basic utilities
eval(snarf('utility.js'));

// Load settings, can be overridden by commandline
eval(snarf('settings.js'));

var i = 0;
var settingsAsString;
var lines = [];


// Event 'data' on stdin: Read every input from stdin and store it in lines
// 
// var lines = [];
// var line;
// do {
//   line = readline();
//   if (line == null) break;
//   lines.push(line);
// } while(true);

stdin.on('data', function(buffer) {
	   var bufferlines = buffer.toString('utf8').split(/\n/);
	   for (var k = 0; k < bufferlines.length; ++k) {
	     if (i == 0) {
	       settingsAsString = bufferlines[i];
	     } else {
	       lines.push(bufferlines[i]);
	     }
	     ++i;
	   }
	 });


// Event 'end' on stdin: Do the processing.
stdin.on('end', function() {

var settings = JSON.parse(settingsAsString);
for (setting in settings) {
  this[setting] = settings[setting];
}
var CONSTANTS = { 'QUANTUM_SIZE': QUANTUM_SIZE };

if (CORRECT_SIGNS === 2) {
  CORRECT_SIGNS_LINES = set(CORRECT_SIGNS_LINES); // for fast checking
}
if (CORRECT_OVERFLOWS === 2) {
  CORRECT_OVERFLOWS_LINES = set(CORRECT_OVERFLOWS_LINES); // for fast checking
}
if (CORRECT_ROUNDINGS === 2) {
  CORRECT_ROUNDINGS_LINES = set(CORRECT_ROUNDINGS_LINES); // for fast checking
}

EXPORTED_FUNCTIONS = set(EXPORTED_FUNCTIONS);

// Load compiler code

eval(snarf('framework.js'));
eval(snarf('modules.js'));
eval(snarf('parseTools.js'));
eval(snarf('intertyper.js'));
eval(snarf('analyzer.js'));
eval(snarf('jsifier.js'));
eval(snarf('runtime.js'));

// Load library, with preprocessing and macros

for (suffix in set('', '_sdl', '_gl')) {
  eval(processMacros(preprocess(read('library' + suffix + '.js'), CONSTANTS)));
}

//===============================
// Main
//===============================

// Read llvm

// Do it

JSify(analyzer(intertyper(lines)));

});
