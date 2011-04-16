
#include <cstdio>

int main(int argc, char** argv) 
{    
    long long v = 0;
    for (int i =0 ; i < 100000 ; ++i) {
        v += i;
    }
    printf("result: %d\n", v);
    return 0;
}

        
