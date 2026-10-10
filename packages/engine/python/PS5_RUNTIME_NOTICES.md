# PS5 Direct Runtime Dependencies

`ps5_runtime.py` can load project-local dependencies from `packages/engine/python/vendor`.

Important licensing note:

- `pyremoteplay` 0.7.6 is licensed under **GPLv3**.
- Its license text is preserved at
  `packages/engine/python/vendor/pyremoteplay-0.7.6.dist-info/LICENSE`.
- Distributing NoBoWo with this bundled sidecar may require GPLv3-compliant
  source distribution and notices for the combined work.
- If GPLv3 is unacceptable for distribution, keep `pyremoteplay` as a
  separately installed optional dependency or replace it before release.

The source package used for the current integration is
`pyremoteplay-0.7.6-py3-none-any.whl` from PyPI. `pyee` is pinned to 8.2.2
because pyremoteplay 0.7.6 imports the removed `pyee.ExecutorEventEmitter` API.
