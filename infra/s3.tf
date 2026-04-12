resource "random_id" "resumes_suffix" {
  byte_length = 4
}

resource "aws_s3_bucket" "resumes" {
  bucket = "${local.name_prefix}-resumes-${random_id.resumes_suffix.hex}"
}

resource "aws_s3_bucket_public_access_block" "resumes" {
  bucket                  = aws_s3_bucket.resumes.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "resumes" {
  bucket = aws_s3_bucket.resumes.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "resumes" {
  bucket = aws_s3_bucket.resumes.id

  versioning_configuration {
    status = "Enabled"
  }
}

# CORS so the extension can PUT directly to a presigned URL from the
# chrome-extension:// origin. Origins are pinned via var.allowed_origins.
resource "aws_s3_bucket_cors_configuration" "resumes" {
  bucket = aws_s3_bucket.resumes.id

  cors_rule {
    allowed_methods = ["PUT"]
    allowed_origins = var.allowed_origins
    allowed_headers = ["Content-Type"]
    max_age_seconds = 3000
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "resumes" {
  bucket = aws_s3_bucket.resumes.id

  rule {
    id     = "expire-old-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}
