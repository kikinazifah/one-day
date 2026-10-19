from django.shortcuts import render

# Create your views here.
def home(request):
    return render(request, 'dashboard/home.html')

def document_creator(request):
    return render(request, 'dashboard/document_creator.html', {
        'active_page': 'document',
    })


def lecture_listener(request):
    return render(request, 'dashboard/lecture_listener.html', {
        'active_page': 'lecture',
    })


def reminder_system(request):
    return render(request, 'dashboard/reminder_system.html', {
        'active_page': 'reminder',
    })


def rag_assistant(request):
    return render(request, 'dashboard/rag_assistant.html', {
        'active_page': 'rag',
    })

def ai_lecturer(request):
    return render(request, 'dashboard/ai_lecturer.html', {
        'active_page': 'ai_lecturer',
    })

def auto_scheduler(request):
    return render(request, "dashboard/auto_scheduler.html", {
        'active_page': 'auto_scheduler',
    })