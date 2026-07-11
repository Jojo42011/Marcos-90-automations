"""Marco override — OSS (Alibaba cloud) upload disabled.

The upstream oss.py imports oss2 unconditionally, but upload only runs when
is_upload_draft=true, which this deployment never sets. Stubbing the module
removes the oss2/crcmod native build dependency entirely.
"""

def upload_to_oss(path):
    raise RuntimeError("OSS upload is disabled in this deployment (is_upload_draft=false)")


def upload_mp4_to_oss(path):
    raise RuntimeError("OSS upload is disabled in this deployment (is_upload_draft=false)")
