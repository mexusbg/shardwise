"""Zip a macOS .app like `ditto -c -k --keepParent`: symlinks stay symlinks, permissions are kept.

electron-builder's zip on Linux follows symlinks, which triples Electron Framework and breaks the bundle's
code signature. Usage: python3 scripts/zip-app.py <path/to/App.app> <out.zip>
"""
import os
import stat
import sys
import zipfile

app, out = sys.argv[1], sys.argv[2]
parent = os.path.dirname(os.path.abspath(app))


def info(path: str, arc: str) -> zipfile.ZipInfo:
    st = os.lstat(path)
    zi = zipfile.ZipInfo(arc, date_time=(1980, 1, 1, 0, 0, 0))
    zi.create_system = 3  # Unix, so external_attr carries the mode (Archive Utility honours it)
    zi.external_attr = (st.st_mode & 0xFFFF) << 16
    zi.compress_type = zipfile.ZIP_DEFLATED  # a ZipInfo's own setting wins over the archive default
    return zi


with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for root, dirs, files in os.walk(app, followlinks=False):
        dirs.sort()
        for name in sorted(dirs + files):
            path = os.path.join(root, name)
            arc = os.path.relpath(path, parent)
            if os.path.islink(path):
                z.writestr(info(path, arc), os.readlink(path), compress_type=zipfile.ZIP_STORED)
            elif os.path.isdir(path):
                zi = info(path, arc + '/')
                zi.external_attr |= 0x10  # MS-DOS directory flag
                z.writestr(zi, b'')
            else:
                with open(path, 'rb') as f:
                    z.writestr(info(path, arc), f.read())
print(f'{out}: {os.path.getsize(out) // 1048576} MB')
