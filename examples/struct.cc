
#include <cstring>
#include <cstdio>
#include <cstdlib>

struct MyObject 
{
    char * value;
    int i;
};


void initObject(MyObject * obj) 
{
    obj->value = strdup("test");
    obj->i = 1;
}

void printObject(MyObject * obj) 
{
    printf("Object: value=%s, i=%d\n", obj->value, obj->i);
}
void freeObject(MyObject * obj) 
{
    if (obj->value) free(obj->value);
}

int main(int argc, char** argv) 
{    
    
    MyObject myObject;
    initObject(&myObject);
    printObject(&myObject);
    freeObject(&myObject);
    return 0;
}

        
