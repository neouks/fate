import sys
from loop import main
u,p=sys.argv[1],sys.argv[2]
r=main([(u,p)],1)
print('RESULT',r[0] if r else None)
