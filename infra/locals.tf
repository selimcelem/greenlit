locals {
  name_prefix  = var.project
  backend_dist = "${path.module}/../backend/dist"
}
