
import akshare as ak
names = [n for n in dir(ak) if ('st' in n.lower() or 'delist' in n.lower() or 'stop' in n.lower() or 'bz' in n.lower() or 'risk' in n.lower())]
print("=== candidates ===")
for n in names:
    print(n)
