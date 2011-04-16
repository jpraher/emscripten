
CXX=/opt/llvm-2.8/bin/clang++
DIS=/opt/llvm-2.8/bin/llvm-dis
JSENG=/opt/nodejs/bin/node
EMSCRIPTEN=../emscripten.py

all: test.js test struct.js struct

%.js: %.ll
	echo $@
	${EMSCRIPTEN} $< ${JSENG} > $@

%.o: %.cc
	${CXX}  -emit-llvm -o $@ -c $<

%.ll: %.o
	${DIS}  $< -show-annotations -o $@

%: %.cc
	${CXX}  -o $@  $<

clean:
	rm -f *.o
	rm -f *.ll
	rm -f *.js
	rm test struct




