import pytest
from fastapi.testclient import TestClient

from taskapi.config import Settings
from taskapi.main import create_app
from taskapi.store import Store


@pytest.fixture
def settings(tmp_path):
    value = Settings(
        data_dir=tmp_path / "data",
        auth_disabled=True,
        chunk_size=4,
        max_upload_bytes=1024 * 1024,
        # Keep API tests deterministic whether or not faster-whisper is installed.
        asr_disabled=True,
    )
    value.ensure_dirs()
    value.resolve_token()
    return value


@pytest.fixture
def store(settings):
    return Store(settings)


@pytest.fixture
def client(settings):
    app = create_app(settings)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def sample_segments():
    return [
        {"id": "seg_00001", "startMs": 0, "endMs": 3000, "text": "呃，大家好，我们我们开始。"},
        {"id": "seg_00002", "startMs": 3000, "endMs": 6500, "text": "这个视频支持三个模式。"},
        {"id": "seg_00003", "startMs": 6500, "endMs": 9000, "text": "但是后面又说支持四个模式，没有解释。"},
        {"id": "seg_00004", "startMs": 9000, "endMs": 12000, "text": "然后我们点击保存。"},
    ]


@pytest.fixture
def sample_video():
    return {
        "bvid": "BV1xx411c7mD",
        "cid": "123456789",
        "page": 2,
        "title": "测试视频",
        "partTitle": "第二P",
        "author": "测试UP主",
        "durationMs": 12000,
        "sourceUrl": "https://www.bilibili.com/video/BV1xx411c7mD/?p=2",
    }
