import pytest
from unittest.mock import patch, MagicMock
import sys
import os

# Add scripts directory to path to import api_server
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
import api_server
from api_server import _parse_html_to_scraped_data

def test_extract_various_image_attributes():
    html_content = """
    <html>
        <head><title>Test Page</title></head>
        <body>
            <p>Some text content to create a paragraph.</p>
            <!-- t66y style -->
            <img ess-data="https://example.com/image.webp" iyl-data="http://a.d/adblo_ck.jpg" referrerpolicy="no-referrer">
            <!-- standard src -->
            <img src="https://example.com/image2.jpg">
            <!-- lazy load data-src -->
            <img data-src="https://example.com/image3.png">
            <!-- empty/invalid img -->
            <img title="no src">
        </body>
    </html>
    """
    
    with patch("api_server.http_requests.get") as mock_get:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {"Content-Type": "image/jpeg"}
        mock_resp.iter_content.return_value = [b"fake_image_data_that_is_short"]
        mock_get.return_value = mock_resp
        
        result = _parse_html_to_scraped_data(html_content, "https://example.com/")
        
        assert result["title"] == "Test Page"
        assert result["totalParagraphs"] == 1
        assert result["totalImages"] == 3
        
        # Verify that http_requests.get was called with the correct URLs extracted from different attributes
        called_urls = [call.args[0] for call in mock_get.call_args_list]
        assert "https://example.com/image.webp" in called_urls
        assert "https://example.com/image2.jpg" in called_urls
        assert "https://example.com/image3.png" in called_urls

def test_extract_inline_base64_image():
    html_content = """
    <html>
        <body>
            <p>Paragraph</p>
            <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=">
        </body>
    </html>
    """
    with patch("api_server.http_requests.get") as mock_get:
        result = _parse_html_to_scraped_data(html_content, "https://example.com/")
        
        assert result["totalImages"] == 1
        # Should not make any network requests for base64 inline images
        mock_get.assert_not_called()
        
        img = result["images"][0]
        assert img["base64"].startswith("data:image/png;base64,")

