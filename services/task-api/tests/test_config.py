from taskapi.config import Settings, load_settings, read_env_file
from taskapi.startup import runtime_lines


def test_dotenv_does_not_override_process_environment(tmp_path, monkeypatch):
    data_dir = tmp_path / "dotenv-data"
    env_file = tmp_path / "service.env"
    env_file.write_text(
        "\n".join(
            [
                "# comment line",
                "",
                "export TASKAPI_DATA_DIR=" + str(data_dir),
                "TASKAPI_TOKEN=token-from-dotenv",
                "TASKAPI_PORT=9999",
                "TASKAPI_CHUNK_SIZE=2048",
                'LLM_MODEL="dotenv-model"',
                "LLM_API_KEY=key-from-dotenv",
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("TASKAPI_ENV_FILE", str(env_file))
    monkeypatch.setenv("LLM_API_KEY", "key-from-process")
    monkeypatch.delenv("TASKAPI_DATA_DIR", raising=False)
    monkeypatch.delenv("TASKAPI_TOKEN", raising=False)
    monkeypatch.delenv("TASKAPI_PORT", raising=False)
    monkeypatch.delenv("TASKAPI_CHUNK_SIZE", raising=False)
    monkeypatch.delenv("LLM_MODEL", raising=False)

    settings = load_settings()

    assert settings.data_dir == data_dir
    assert settings.data_dir.is_dir()
    assert settings.port == 9999
    assert settings.chunk_size == 2048
    assert settings.llm_model == "dotenv-model"
    # Process environment wins over .env.
    assert settings.llm_api_key == "key-from-process"
    # Token from .env is resolved (and cached) during load_settings().
    assert settings.token == "token-from-dotenv"


def test_read_env_file_tolerates_missing_file_and_quotes(tmp_path):
    assert read_env_file(tmp_path / "missing.env") == {}
    env_file = tmp_path / "quotes.env"
    env_file.write_text(
        "PLAIN=value\nSINGLE='a b'\nDOUBLE=\"c\\\"d\"\nWINDOWS_PATH=\"C:\\new\\data\"\nINVALID LINE\n1BAD=x\nEMPTY=\n",
        encoding="utf-8",
    )
    values = read_env_file(env_file)
    assert values == {
        "PLAIN": "value",
        "SINGLE": "a b",
        "DOUBLE": 'c"d',
        # Backslashes must survive verbatim so Windows paths are not corrupted.
        "WINDOWS_PATH": "C:\\new\\data",
        "EMPTY": "",
    }


def test_token_is_persisted_and_reused(tmp_path, monkeypatch):
    monkeypatch.delenv("TASKAPI_TOKEN", raising=False)
    settings = Settings(data_dir=tmp_path / "data", auth_disabled=False)
    settings.ensure_dirs()
    token = settings.resolve_token()
    token_file = settings.data_dir / "token.txt"
    assert token_file.read_text(encoding="utf-8").strip() == token
    assert len(token) >= 24

    again = Settings(data_dir=tmp_path / "data", auth_disabled=False)
    again.ensure_dirs()
    assert again.resolve_token() == token


def test_startup_banner_prints_token_but_never_api_keys(tmp_path, monkeypatch):
    monkeypatch.setenv("TASKAPI_TOKEN", "banner-token-123")
    settings = Settings(
        data_dir=tmp_path / "data",
        auth_disabled=False,
        llm_api_key="sk-should-never-be-printed",
        asr_api_key="asr-should-never-be-printed",
    )
    settings.ensure_dirs()
    settings.resolve_token()

    lines = runtime_lines(settings, "serve", "127.0.0.1", 8765)
    banner = "\n".join(lines)

    assert "banner-token-123" in banner
    assert "扩展设置页" in banner
    assert "http://127.0.0.1:8765" in banner
    assert str((tmp_path / "data").resolve()) in banner
    assert "已配置" in banner
    assert "sk-should-never-be-printed" not in banner
    assert "asr-should-never-be-printed" not in banner


def test_startup_banner_reports_offline_mode(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", auth_disabled=True, asr_disabled=True)
    settings.ensure_dirs()
    settings.resolve_token()
    banner = "\n".join(runtime_lines(settings, "worker"))
    assert "数据目录" in banner
    assert "已关闭鉴权" in banner
    assert "HeuristicLLM" in banner
    assert "监听地址" not in banner  # workers do not bind a port
    assert "NEEDS_INPUT" in banner
