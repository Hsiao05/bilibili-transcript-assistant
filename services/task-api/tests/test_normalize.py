from taskapi.pipeline.normalize import (
    build_blocks,
    clean_text,
    diff_edits,
    join_texts,
    replace_outside_quotes,
)


def test_removes_fillers_and_stutters():
    assert clean_text("呃，我们我们先看这个接口。", "standard") == "我们先看这个接口。"
    assert clean_text("嗯，好的。", "standard") == "好的。"
    assert clean_text("那个，我们先开始。", "standard") == "我们先开始。"


def test_preserves_meaningful_words():
    assert clean_text("然后我们点击保存。", "standard") == "然后我们点击保存。"
    assert clean_text("这可能导致失败。", "standard") == "这可能导致失败。"
    assert clean_text("这个参数就是零。", "standard") == "这个参数就是零。"
    assert clean_text("支持三个，不是四个。", "standard") == "支持三个，不是四个。"


def test_protects_quotes_from_cleanup():
    text = "他说“呃，原话就是这样”，呃，然后继续。"
    assert clean_text(text, "standard") == "他说“呃，原话就是这样”，然后继续。"


def test_format_cleanup():
    assert clean_text("  多余空格，，  测试！！！  ", "light") == "多余空格，测试！！！"
    assert clean_text("网址 https://example.com/a..b 保留", "standard") == "网址 https://example.com/a..b 保留"


def test_term_replacement_outside_quotes():
    text = "他说“滴普西克”，滴普西克很强。"
    cleaned, edits = replace_outside_quotes(text, ["滴普西克"], "DeepSeek")
    assert cleaned == "他说“滴普西克”，DeepSeek很强。"
    assert len(edits) == 1
    assert text[edits[0].start_offset : edits[0].end_offset] == "滴普西克"


def test_diff_edits_offsets_match():
    old = "呃，我们开始。"
    new = "我们开始。"
    edits = diff_edits(old, new, "format", "测试")
    assert edits
    for edit in edits:
        assert old[edit.start_offset : edit.end_offset] == edit.original
        assert new[edit.start_offset : edit.start_offset + len(edit.replacement)] == edit.replacement


def test_join_and_blocks():
    assert join_texts("第一句话", "第二句话", 400) == "第一句话，第二句话"
    assert join_texts("第一句话。", "第二句话", 400) == "第一句话。第二句话"
    assert join_texts("Hello", "world", 400) == "Hello world"

    class S:
        def __init__(self, i, start, end, text):
            self.id = i
            self.start_ms = start
            self.end_ms = end
            self.text = text

    blocks = build_blocks(
        [
            S("s1", 0, 2000, "开头"),
            S("s2", 2100, 4000, "继续"),
            S("s3", 20000, 22000, "很晚的内容"),
        ]
    )
    assert len(blocks) == 2
    assert blocks[0]["sourceSegmentIds"] == ["s1", "s2"]
    assert blocks[1]["sourceSegmentIds"] == ["s3"]
    assert blocks[0]["startMs"] == 0 and blocks[0]["endMs"] == 4000
