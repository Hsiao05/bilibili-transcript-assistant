import json

from taskapi.pipeline.clean import CleanOptions, clean_document
from taskapi.pipeline.markdown import render_document_markdown
from taskapi.pipeline.summary import summarize_document
from taskapi.providers.llm import LLMProvider
from taskapi.schemas import Block, Revision, VideoRef


class FakeLLM(LLMProvider):
    provider_id = "fake"
    model = "fake-model"
    is_heuristic = False

    def chat_json(self, system, user, max_tokens=4096):
        if "术语审校" in system:
            return {
                "terms": [
                    {
                        "canonical": "DeepSeek",
                        "variants": ["滴普西克"],
                        "entityType": "product",
                        "evidenceType": "context_only",
                        "evidenceSegmentIds": ["s2"],
                    }
                ]
            }
        if "一致性审校" in system:
            return {
                "issues": [
                    {
                        "blockId": "block_0001",
                        "quote": "支持三个模式",
                        "suggestion": None,
                        "type": "contradiction",
                        "reason": "后文出现支持四个模式",
                        "evidenceSegmentIds": ["s2", "s3"],
                    }
                ]
            }
        if "文字稿的编辑" in system:
            payload = json.loads(user)
            return {"segments": [{"id": item["id"], "text": item["text"]} for item in payload["segments"]]}
        raise AssertionError(f"unexpected prompt: {system[:40]}")


def test_clean_pipeline_with_fake_llm():
    segments = [
        {"id": "s1", "startMs": 0, "endMs": 2000, "text": "呃，我们来聊聊滴普西克。"},
        {"id": "s2", "startMs": 2000, "endMs": 5000, "text": "这个产品支持三个模式。"},
        {"id": "s3", "startMs": 5000, "endMs": 8000, "text": "后面又说支持四个模式，没有解释。"},
    ]
    outcome = clean_document(segments, CleanOptions(strength="standard"), FakeLLM())
    assert outcome.blocks
    assert outcome.blocks[0].text.startswith("我们来聊聊")
    # The discovered term is only a suggestion, so original text stays and a correction is offered.
    assert any(c.change_type == "term" for c in outcome.corrections)
    assert any(c.original == "滴普西克" for c in outcome.corrections)
    assert any("支持三个模式" in c.original for c in outcome.corrections)
    consistency = next(c for c in outcome.corrections if "支持三个模式" in c.original)
    assert consistency.change_type == "consistency"
    assert consistency.replacement is None
    assert outcome.terms
    assert outcome.stats["segments"] == 3
    assert all(block.source_segment_ids for block in outcome.blocks)


def test_clean_pipeline_heuristic_preserves_meaning():
    segments = [
        {"id": "s1", "startMs": 0, "endMs": 2000, "text": "然后我们点击保存。"},
        {"id": "s2", "startMs": 2000, "endMs": 4000, "text": "这可能导致失败。"},
        {"id": "s3", "startMs": 4000, "endMs": 6000, "text": "这个参数就是零。"},
    ]
    from taskapi.providers.llm import HeuristicLLM

    outcome = clean_document(segments, CleanOptions(strength="standard"), HeuristicLLM())
    text = "".join(block.text for block in outcome.blocks)
    assert "然后" in text
    assert "可能" in text
    assert "就是" in text


def test_summary_citations_are_valid():
    from taskapi.providers.llm import HeuristicLLM

    video = VideoRef(bvid="BV1xx411c7mD", cid="1", page=2, title="测试视频", author="UP")
    blocks = [
        Block(id="b1", source_segment_ids=["s1"], text="我认为这个设计不错。它支持三个模式。", start_ms=0, end_ms=3000),
        Block(id="b2", source_segment_ids=["s2"], text="最后总结一下，效果需要观察，可能有三成提升。", start_ms=3000, end_ms=7000),
    ]
    index = {"s1": {"startMs": 0, "endMs": 3000}, "s2": {"startMs": 3000, "endMs": 7000}}
    summary = summarize_document(video, blocks, index, HeuristicLLM(), "B站AI字幕")
    assert summary.overview
    assert summary.chapters
    for chapter in summary.chapters:
        for point in chapter.points:
            assert point.segment_ids
            for sid in point.segment_ids:
                assert sid in index
    assert summary.coverage.sources == ["B站AI字幕"]


def test_applied_edits_are_patches_against_base_block():
    from taskapi.providers.llm import HeuristicLLM

    base_blocks = {
        "block_0001": "呃，我们开始。",
        "block_0002": "然后点击保存。",
    }
    segments = [
        {
            "id": "s1",
            "startMs": 0,
            "endMs": 2000,
            "text": base_blocks["block_0001"],
            "blockId": "block_0001",
            "sourceSegmentIds": ["s1"],
        },
        {
            "id": "s2",
            "startMs": 2000,
            "endMs": 4000,
            "text": base_blocks["block_0002"],
            "blockId": "block_0002",
            "sourceSegmentIds": ["s2"],
        },
    ]
    outcome = clean_document(segments, CleanOptions(strength="standard"), HeuristicLLM())
    assert outcome.applied_edits
    for edit in outcome.applied_edits:
        base_text = base_blocks[edit.block_id]
        # blockId references the parent revision block, and offsets are a precise patch:
        # baseText[startOffset:endOffset] == original (auditable / rollbackable).
        assert base_text[edit.start_offset : edit.end_offset] == edit.original
        assert edit.source_segment_ids
        assert edit.reason
    filler = next(edit for edit in outcome.applied_edits if edit.original == "呃，")
    assert (filler.start_offset, filler.end_offset) == (0, 2)
    assert filler.replacement == ""
    assert filler.change_type == "format"


def test_applied_edits_cover_glossary_replacement():
    from taskapi.providers.llm import HeuristicLLM

    base_text = "比如滴普西克这个模型。"
    segments = [
        {
            "id": "s1",
            "startMs": 0,
            "endMs": 2000,
            "text": base_text,
            "blockId": "block_0001",
            "sourceSegmentIds": ["s1"],
        },
    ]
    options = CleanOptions(
        strength="standard",
        glossary=[{"canonical": "DeepSeek", "variants": ["滴普西克"], "entityType": "product"}],
    )
    outcome = clean_document(segments, options, HeuristicLLM())
    assert outcome.blocks[0].text == "比如DeepSeek这个模型。"
    term_edits = [edit for edit in outcome.applied_edits if edit.change_type == "term"]
    assert len(term_edits) == 1
    edit = term_edits[0]
    assert edit.block_id == "block_0001"
    assert base_text[edit.start_offset : edit.end_offset] == "滴普西克"
    assert edit.replacement == "DeepSeek"
    assert edit.evidence_type == "user_glossary"


def test_markdown_export_contains_header_and_links(tmp_path):
    video = VideoRef(
        bvid="BV1xx411c7mD",
        cid="1",
        page=2,
        title="测试视频",
        part_title="第二P",
        author="UP主",
        duration_ms=7000,
    )
    revision = Revision(
        id="rev1",
        document_id="doc1",
        kind="cleaned",
        blocks=[Block(id="b1", source_segment_ids=["s1"], text="正文内容。", start_ms=65000, end_ms=70000)],
        pipeline_version="clean-v1:standard",
        created_by="model",
    )
    markdown = render_document_markdown(video, revision, "bilibili_ai_subtitle")
    assert "# 测试视频" in markdown
    assert "作者　UP主" in markdown
    assert "?p=2" in markdown
    assert "&t=65" in markdown
    assert "B站AI字幕" in markdown
    assert "## 整理稿" in markdown
    assert "正文内容" in markdown
